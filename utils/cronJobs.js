const cron = require('node-cron');
const axios = require('axios');
const db = require('../database/db');

async function markNoShowBookings() {
  let connection;
  const unpaidForBas = [];

  try {
    connection = await db.getConnection();
    await connection.beginTransaction();

    const [expired] = await connection.query(`
      SELECT b.id, b.client_id, b.payment_status,
             p.cost, p.title AS service_title, p.bas_guid AS service_bas_guid,
             c.bas_guid AS client_bas_guid
      FROM bookings b
      JOIN price_list p ON b.price_id = p.id
      JOIN clients c ON b.client_id = c.id
      WHERE b.status = 'scheduled'
        AND b.end_time < NOW()
      FOR UPDATE
    `);

    for (const b of expired) {
      await connection.query("UPDATE bookings SET status = 'no_show' WHERE id = ?", [b.id]);

      if (b.payment_status === 'unpaid') {
        await connection.query(
          "UPDATE clients SET deposit_balance = deposit_balance - ? WHERE id = ?",
          [b.cost, b.client_id]
        );

        if (b.client_bas_guid) {
          unpaidForBas.push(b);
        }
      }
    }

    await connection.commit();

    if (expired.length > 0) {
      console.log(`[CRON] Позначено як неявку (no_show): ${expired.length} запис(ів).`);
    }

    for (const booking of unpaidForBas) {
      axios.post('http://localhost/base/hs/sync/sale', {
        action_type: 'sale_only',
        client_guid: booking.client_bas_guid,
        service_guid: booking.service_bas_guid,
        service_title: booking.service_title,
        sum: booking.cost,
        payment_method: 'balance'
      }, {
        auth: { username: 'Адміністратор', password: '' }
      })
        .then(async (basResponse) => {
          if (basResponse.data && basResponse.data.bas_doc_guid) {
            await db.query("UPDATE bookings SET bas_doc_guid = ? WHERE id = ?", [basResponse.data.bas_doc_guid, booking.id]);
          }
        })
        .catch(err => console.error(`[BAS] Помилка вивантаження no_show (booking #${booking.id}):`, err.response?.data || err.message));
    }
  } catch (error) {
    if (connection) await connection.rollback();
    console.error('[CRON] Помилка оновлення статусів no_show:', error.message);
  } finally {
    if (connection) connection.release();
  }
}

async function syncDailyPiecework(targetDate = null) {
  try {
    const dateStr = targetDate || new Date().toLocaleDateString('en-CA');

    const [rows] = await db.query(`
      SELECT t.bas_guid AS trainer_guid, COUNT(b.id) AS count
      FROM bookings b
      JOIN trainers t ON b.trainer_id = t.id
      WHERE b.status = 'attended'
        AND DATE(b.start_time) = ?
        AND t.bas_guid IS NOT NULL
      GROUP BY t.id, t.bas_guid
    `, [dateStr]);

    if (rows.length === 0) {
      console.log(`[CRON] За ${dateStr} немає проведених тренувань для вигрузки виробітку.`);
      return;
    }

    await axios.post('http://localhost/base/hs/sync/piecework', {
      date: dateStr,
      items: rows
    }, {
      auth: { username: 'Адміністратор', password: '' }
    });

    console.log(`[BAS] Виробіток за ${dateStr} вивантажено (${rows.length} тренер(ів)).`);
  } catch (err) {
    console.error('[BAS] Помилка вивантаження виробітку:', err.response?.data || err.message);
  }
}

function initCronJobs() {
  markNoShowBookings();
  cron.schedule('15 10-23 * * *', () => {
    markNoShowBookings();
  });
  cron.schedule('30 23 * * *', () => {
    syncDailyPiecework();
  });
  console.log('[CRON]');
}

module.exports = { initCronJobs };

