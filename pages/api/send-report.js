// pages/api/send-report.js
import mysql from "mysql2/promise";
import fetch from "node-fetch";

/* Reuse pool between warm invocations */
const pool =
  global.__mysqlPool ??
  (process.env.DATABASE_URL
    ? mysql.createPool(process.env.DATABASE_URL)
    : mysql.createPool({
        host: process.env.MYSQL_HOST,
        user: process.env.MYSQL_USER,
        password: process.env.MYSQL_PASSWORD,
        database: process.env.MYSQL_DATABASE,
        port: Number(process.env.MYSQL_PORT || 3306),
        waitForConnections: true,
        connectionLimit: 2,
        queueLimit: 0,
      }));
global.__mysqlPool = pool;

export default async function handler(req, res) {
  try {
    // 1) Secret check: header 'x-secret-token' or query ?secret=
    const headerSecret =
      req.headers["x-secret-token"] || req.headers["x-secret"];
    const querySecret = req.query?.secret;
    const CRON_SECRET = process.env.CRON_SECRET;
    if (CRON_SECRET) {
      if (headerSecret !== CRON_SECRET && querySecret !== CRON_SECRET) {
        return res.status(401).json({ ok: false, error: "Unauthorized" });
      }
    }

    // 2) Time window (hours)
    const hours = Number(process.env.REPORT_WINDOW_HOURS) || 1;
    const since = new Date(Date.now() - hours * 3600 * 1000);

    // 3) Query: trim merchant name to first word using SUBSTRING_INDEX
    const sql = `
      SELECT 
        SUM(CAST(lp.transaction_amount AS DECIMAL(15,2))) AS total_amount, 
        SUBSTRING_INDEX(TRIM(m.name), ' ', 1) AS name
      FROM live_payment lp
      JOIN merchant m 
        ON lp.created_merchant = m.id
      WHERE lp.transaction_status = 'success'
      GROUP BY name;
    `;

    const [rows] = await pool.execute(sql);

    // Calculate grand total across all merchants
    const grandTotal = rows.reduce((sum, r) => {
      const val = r.total_amount === null ? 0 : Number(r.total_amount);
      return sum + val;
    }, 0);

    // 4) Build Telegram message with formatted amounts
    let message = `✅ Transaction summary (last ${hours} hour${
      hours > 1 ? "s" : ""
    }):\n\n`;

    if (!rows.length) {
      message += "No successful transactions in this window.";
    } else {
      for (const r of rows) {
        const amt =
          r.total_amount === null
            ? "0.00"
            : Number(r.total_amount).toLocaleString("en-IN", {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              });
        const safeName = String(r.name || "Unknown").replace(/\n/g, " ");
        message += `${safeName}: ₹${amt}\n`;
      }
      message += `\nTotal: ₹${grandTotal.toLocaleString("en-IN", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })}`;
    }

    // 5) Send to Telegram
    const BOT_TOKEN = process.env.BOT_TOKEN;
    const CHAT_ID = process.env.CHAT_ID;
    if (!BOT_TOKEN || !CHAT_ID) throw new Error("BOT_TOKEN or CHAT_ID missing");

    const tgRes = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: CHAT_ID, text: message }),
      }
    );
    const tgJson = await tgRes.json();
    if (!tgJson.ok) {
      console.error("Telegram API error:", tgJson);
      return res.status(502).json({ ok: false, telegram: tgJson });
    }

    return res
      .status(200)
      .json({ ok: true, sent: true, telegram: tgJson.result });
  } catch (err) {
    console.error("Handler error:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
