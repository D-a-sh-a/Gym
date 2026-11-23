const db = require('../database/db');
const bcrypt = require('bcrypt');
const mailer = require('../utils/mailer');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');

exports.getDashboard = async (req, res) => {
  try {
    const selectedTrainerId = req.query.trainer_id;
    let events = [];

    let selectedTrainerName = '';
    if (selectedTrainerId) {
      const [tr] = await db.query("SELECT full_name FROM trainers WHERE id = ?", [selectedTrainerId]);
      if (tr.length > 0) selectedTrainerName = tr[0].full_name;
    }

    if (selectedTrainerId) {
      const sql = `
        SELECT b.id, b.start_time, b.status, b.payment_status,
               c.id AS client_id, c.full_name AS client_name, c.deposit_balance,
               t.full_name AS trainer_name,
               p.title AS service, p.cost AS service_cost
        FROM bookings b
        JOIN clients c ON b.client_id = c.id
        JOIN trainers t ON b.trainer_id = t.id
        JOIN price_list p ON b.price_id = p.id
        WHERE b.trainer_id = ?
          AND b.status NOT IN ('cancelled_by_client', 'cancelled_by_manager')
      `;
      const [bookings] = await db.query(sql, [selectedTrainerId]);

      events = bookings.map(b => {
        const start = new Date(b.start_time);
        const isPaid = b.payment_status !== 'unpaid';

        let color = '#F39C12';
        if (b.status === 'attended') color = '#198754';
        else if (b.status === 'no_show') color = '#DC3545';
        else if (isPaid) color = '#2ECC71';

        const payIcon = isPaid ? '✅' : '💳?';

        return {
          id: b.id,
          title: `${payIcon} ${b.client_name}`,
          start: start.toISOString(),
          end: new Date(start.getTime() + 60 * 60000).toISOString(),
          color: color,
          textColor: '#FFFFFF',
          extendedProps: {
            client: b.client_name,
            trainer: b.trainer_name,
            service: b.service,
            cost: b.service_cost,
            depositBalance: Number(b.deposit_balance || 0),
            status: b.status,
            paymentStatus: b.payment_status,
            dateOnly: start.toLocaleDateString('en-CA'),
            timeOnly: start.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' })
          }
        };
      });
    }

    const [trainers] = await db.query("SELECT id, full_name FROM trainers WHERE is_active = 1 ORDER BY full_name");
    const [prices] = await db.query("SELECT id, title, cost FROM price_list WHERE LOWER(title) LIKE '%персональн%'");

    res.render('manager_dashboard', {
      user: req.session.user,
      eventsJson: JSON.stringify(events),
      trainersList: trainers,
      pricesList: prices,
      selectedTrainerId: selectedTrainerId ? Number(selectedTrainerId) : null,
      selectedTrainerName: selectedTrainerName
    });
  } catch (error) {
    console.error(error);
    res.send("Помилка дашборда");
  }
};

exports.getClientsPage = async (req, res) => {
  try {
    const searchQuery = req.query.search || '';
    const barcodeQuery = req.query.barcode || '';
    let clients = [];

    const [prices] = await db.query(
      "SELECT * FROM price_list WHERE title LIKE '%абонемент%' OR title LIKE '%разов%' OR title LIKE '%день%' OR duration LIKE '%місяць%' OR duration LIKE '%рік%' OR duration LIKE '%день%' ORDER BY cost ASC"
    );

    const [trainers] = await db.query("SELECT id, full_name FROM trainers WHERE is_active = 1 ORDER BY full_name");
    const [personalPrices] = await db.query("SELECT id, title, cost FROM price_list WHERE LOWER(title) LIKE '%персональн%'");

    if (searchQuery || barcodeQuery) {
      let sql = `
        SELECT c.*, 
          (SELECT p.title FROM subscriptions s JOIN price_list p ON s.price_id = p.id WHERE s.client_id = c.id ORDER BY s.end_date DESC LIMIT 1) as sub_title,
          (SELECT s.end_date FROM subscriptions s WHERE s.client_id = c.id ORDER BY s.end_date DESC LIMIT 1) as sub_date,
          EXISTS(SELECT 1 FROM subscriptions s WHERE s.client_id = c.id) as has_any_purchase,
          (
            SELECT p.cost 
            FROM subscriptions s 
            JOIN price_list p ON s.price_id = p.id 
            WHERE s.client_id = c.id 
              AND (LOWER(p.title) LIKE '%разов%' OR LOWER(p.duration) LIKE '%день%')
              AND s.purchase_date >= DATE_SUB(NOW(), INTERVAL 30 DAY)
              AND NOT EXISTS (
                  SELECT 1 FROM subscriptions s2
                  JOIN price_list p2 ON s2.price_id = p2.id
                  WHERE s2.client_id = c.id
                    AND LOWER(p2.title) NOT LIKE '%разов%' 
                    AND LOWER(p2.duration) NOT LIKE '%день%'
              )
            ORDER BY s.purchase_date DESC LIMIT 1
          ) as discount_amount
        FROM clients c
        WHERE 1=1
      `;
      const params = [];

      if (searchQuery) {
        sql += " AND (c.full_name LIKE ? OR c.phone LIKE ? OR c.email LIKE ?)";
        params.push(`%${searchQuery}%`, `%${searchQuery}%`, `%${searchQuery}%`);
      }
      if (barcodeQuery) {
        sql += " AND c.barcode = ?";
        params.push(barcodeQuery);
      }

      sql += " ORDER BY c.full_name ASC";

      const [clientsRaw] = await db.query(sql, params);

      let bookingsByClient = {};
      if (clientsRaw.length > 0) {
        const clientIds = clientsRaw.map(c => c.id);
        const [todayBookings] = await db.query(`
          SELECT b.id, b.client_id, b.trainer_id, b.start_time, b.payment_status,
                 t.full_name AS trainer_name, p.title AS service_title, p.cost
          FROM bookings b
          JOIN trainers t ON b.trainer_id = t.id
          JOIN price_list p ON b.price_id = p.id
          WHERE b.client_id IN (?)
            AND DATE(b.start_time) = CURDATE()
            AND b.status = 'scheduled'
          ORDER BY b.start_time ASC
        `, [clientIds]);

        todayBookings.forEach(b => {
          if (!bookingsByClient[b.client_id]) bookingsByClient[b.client_id] = [];
          bookingsByClient[b.client_id].push({
            ...b,
            date_only: new Date(b.start_time).toLocaleDateString('en-CA'),
            time_str: new Date(b.start_time).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' }),
            is_unpaid: b.payment_status === 'unpaid'
          });
        });
      }

      const today = new Date();
      const nextWeek = new Date();
      nextWeek.setDate(today.getDate() + 7);

      clients = clientsRaw.map(client => {
        let status = { text: 'Немає активного абонементу', class: 'secondary', is_active: false };

        const clientBookings = (bookingsByClient[client.id] || []).map(b => ({
          ...b,
          can_pay_balance: Number(client.deposit_balance || 0) >= Number(b.cost),
          client_balance: Number(client.deposit_balance || 0)
        }));
        if (client.sub_date) {
          const endDate = new Date(client.sub_date);
          const dateStr = endDate.toLocaleDateString('uk-UA');
          if (endDate < today) {
            status = { text: 'Немає активного абонементу (Закінчився)', class: 'secondary', is_active: false };
          } else {
            status.is_active = true;
            if (endDate <= nextWeek) {
              status.class = 'warning';
              status.text = `Закінчується: ${dateStr}`;
            } else {
              status.class = 'success';
              status.text = `Діє до: ${dateStr}`;
            }
          }
        }

        return {
          ...client,
          deposit_balance: Number(client.deposit_balance || 0),
          is_debt: Number(client.deposit_balance || 0) < 0,
          today_bookings: clientBookings,
          subscription_status: status,
          sub_title_display: status.is_active ? client.sub_title : '',
          has_any_purchase: Boolean(client.has_any_purchase),
          discount_amount: client.discount_amount ? Number(client.discount_amount) : 0
        };
      });
    }

    res.render('manager_clients', {
      user: req.session.user,
      trainersList: trainers,
      personalPrices: personalPrices,
      clients,
      prices,
      pricesJson: JSON.stringify(prices),
      searchQuery,
      barcodeQuery,
      hasSearched: !!(searchQuery || barcodeQuery)
    });
  } catch (e) {
    console.error(e);
    res.send("Error");
  }
};

exports.sellSubscription = async (req, res) => {
  try {
    const { client_id, price_id, payment_method } = req.body;

    const [priceData] = await db.query("SELECT title, duration, cost, bas_guid FROM price_list WHERE id = ?", [price_id]);
    const durationStr = (priceData[0].duration || '').toLowerCase();
    const titleStr = (priceData[0].title || '').toLowerCase();
    const service_guid = priceData[0].bas_guid;

    let finalCost = priceData[0].cost;
    const purchaseDate = new Date();

    const isTryingToBuySingle = durationStr.includes('день') || titleStr.includes('разов');

    if (isTryingToBuySingle) {
      const [anySub] = await db.query("SELECT id FROM subscriptions WHERE client_id = ? LIMIT 1", [client_id]);
      if (anySub.length > 0) {
        return res.send(`<script>alert('Клієнт вже має історію покупок. Разове відвідування недоступне!'); window.history.back();</script>`);
      }
    } else {
      const [singleVisit] = await db.query(`
        SELECT p.cost
        FROM subscriptions s
        JOIN price_list p ON s.price_id = p.id
        WHERE s.client_id = ? 
          AND (LOWER(p.title) LIKE '%разов%' OR LOWER(p.duration) LIKE '%день%')
          AND s.purchase_date >= DATE_SUB(NOW(), INTERVAL 30 DAY)
          AND NOT EXISTS (
              SELECT 1 FROM subscriptions s2
              JOIN price_list p2 ON s2.price_id = p2.id
              WHERE s2.client_id = s.client_id
                AND LOWER(p2.title) NOT LIKE '%разов%' 
                AND LOWER(p2.duration) NOT LIKE '%день%'
          )
        ORDER BY s.purchase_date DESC LIMIT 1
      `, [client_id]);

      if (singleVisit.length > 0) {
        const discount = Number(singleVisit[0].cost);
        finalCost = Math.max(0, finalCost - discount);
        console.log(`[ЗНИЖКА] Знайдено разовий візит за останні 30 днів. Відраховано ${discount} грн.`);
      }
    }

    const [activeSub] = await db.query(
      "SELECT end_date FROM subscriptions WHERE client_id = ? AND end_date >= CURDATE() ORDER BY end_date DESC LIMIT 1",
      [client_id]
    );

    let activationDate = new Date();
    if (activeSub.length > 0) {
      const currentEndDate = new Date(activeSub[0].end_date);
      activationDate = new Date(currentEndDate);
      activationDate.setDate(activationDate.getDate() + 1);
    }
    const endDate = new Date(activationDate);

    if (durationStr.includes('рік') || titleStr.includes('рік')) {
      endDate.setFullYear(endDate.getFullYear() + 1);
    } else if (durationStr.includes('місяць') || titleStr.includes('місяць')) {
      endDate.setMonth(endDate.getMonth() + 1);
    } else if (durationStr.includes('день') || durationStr.includes('разов') || titleStr.includes('разов')) {
      endDate.setDate(endDate.getDate() + 1);
    } else {
      endDate.setDate(endDate.getDate() + 30);
    }

    const [subResult] = await db.query(
      "INSERT INTO subscriptions (client_id, price_id, purchase_date, activation_date, end_date, source, payment_method) VALUES (?, ?, ?, ?, ?, 'manager', ?)",
      [client_id, price_id, purchaseDate, activationDate, endDate, payment_method]
    );
    const newSubId = subResult.insertId;

    const [clientData] = await db.query("SELECT barcode, bas_guid, full_name FROM clients WHERE id = ?", [client_id]);
    const barcode = clientData.length > 0 ? clientData[0].barcode : '';
    const bas_guid = clientData.length > 0 ? clientData[0].bas_guid : null;

    res.redirect(`/manager/clients?barcode=${barcode}`);

    if (bas_guid) {
      axios.post('http://localhost/base/hs/sync/sale', {
        client_guid: bas_guid,
        service_guid: service_guid,
        service_title: priceData[0].title,
        sum: finalCost,
        payment_method: payment_method
      }, {
        auth: { username: 'Адміністратор', password: '' }
      })
        .then(async (basResponse) => {
          if (basResponse.data && basResponse.data.bas_doc_guid) {
            await db.query(
              "UPDATE subscriptions SET bas_doc_guid = ? WHERE id = ?",
              [basResponse.data.bas_doc_guid, newSubId]
            );
            console.log(`[BAS] GUID реалізації (${basResponse.data.bas_doc_guid}) записано в підписку #${newSubId}`);
          }
        })
        .catch(basError => {
          const errorDetails = basError.response && basError.response.data
            ? JSON.stringify(basError.response.data)
            : basError.message;
          console.error('[BAS] Помилка вивантаження продажу:', errorDetails);
        });
    }

  } catch (e) {
    console.error(e);
    res.send("Помилка при продажі абонемента");
  }
};

exports.registerClient = async (req, res) => {
  const { last_name = '', first_name = '', middle_name = '', email, phone, birth_date } = req.body;
  const full_name = [last_name.trim(), first_name.trim(), middle_name.trim()].filter(Boolean).join(' ');

  const connection = await db.getConnection();

  let newClientId;
  let rawPassword;
  let barcode;

  try {
    await connection.beginTransaction();

    rawPassword = uuidv4().slice(0, 8);
    const hashedPassword = await bcrypt.hash(rawPassword, 10);
    barcode = Math.floor(100000000000 + Math.random() * 900000000000).toString();

    const [uRes] = await connection.query(
      "INSERT INTO users (login, password, role) VALUES (?, ?, 'client')",
      [email, hashedPassword]
    );
    newClientId = uRes.insertId;

    await connection.query(
      "INSERT INTO clients (id, full_name, phone, email, birth_date, barcode) VALUES (?, ?, ?, ?, ?, ?)",
      [newClientId, full_name, phone, email, birth_date, barcode]
    );

    await connection.commit();
  } catch (error) {
    await connection.rollback();
    console.error("Критична помилка БД при реєстрації:", error);
    return res.status(500).send("Помилка бази даних. Клієнта не створено.");
  } finally {
    connection.release();
  }

  res.redirect(`/manager/clients?barcode=${barcode}`);

  const barcodeUrl = `https://barcode.tec-it.com/barcode.ashx?data=${barcode}&code=Code128&dpi=96`;

  const mailHtml = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #ddd; border-radius: 8px;">
        <h2 style="color: #198754;">Вітаємо, ${first_name || full_name}!</h2>
        <p>Ви успішно зареєстровані у нашому спортзалі.</p>
        <p>Ваш логін: <strong>${email}</strong></p>
        <p>Ваш пароль: <strong>${rawPassword}</strong></p>
        
        <div style="text-align: center; margin: 20px 0; padding: 15px; background-color: #f8f9fa; border-radius: 8px;">
            <p style="margin-bottom: 10px;">Ваш персональний штрихкод для входу:</p>
            <img src="${barcodeUrl}" alt="Штрихкод ${barcode}" style="max-width: 100%; height: auto;">
        </div>

        <p>💡 <b>Порада:</b> Ми прикріпили штрихкод до цього листа як файл. Збережіть його в галерею телефону, щоб він завжди був під рукою!</p>

        <hr style="border: 0; border-top: 1px solid #eee;">
        <p style="color: red; font-size: 14px;">⚠️ Обов'язково змініть цей пароль в особистому кабінеті!</p>
        <a href="http://localhost:3000/login" style="display: inline-block; padding: 10px 20px; background-color: #198754; color: white; text-decoration: none; border-radius: 5px;">Увійти в кабінет</a>
    </div>`;

  const attachments = [
    {
      filename: `GYM_Barcode_${barcode}.png`,
      path: barcodeUrl
    }
  ];

  mailer.sendMail(email, "Реєстрація в GYM", mailHtml, attachments)
    .catch(err => console.error("Фонова помилка пошти:", err));

  axios.post('http://localhost/base/hs/sync/client', {
    full_name: full_name,
    email: email,
    phone: phone,
    barcode: barcode
  }, {
    auth: { username: 'Адміністратор', password: '' }
  })
    .then(async (basResponse) => {
      if (basResponse.data && basResponse.data.bas_guid) {
        await db.query('UPDATE clients SET bas_guid = ? WHERE id = ?', [basResponse.data.bas_guid, newClientId]);
        console.log(`[BAS] Клієнта ${full_name} успішно вивантажено в 1С!`);
      }
    })
    .catch(basError => {
      console.error('[BAS] Фонова помилка синхронізації:', basError.message);
    });
};

exports.resetPassword = async (req, res) => {
  try {
    const { client_id, client_email } = req.body;
    const newPass = uuidv4().slice(0, 8);
    const hashed = await bcrypt.hash(newPass, 10);
    await db.query("UPDATE users SET password = ? WHERE id = ?", [hashed, client_id]);
    mailer.sendMail(client_email, "Скидання пароля", `<h3>Ваш пароль було скинуто</h3>
     <p>Новий пароль: <strong>${newPass}</strong></p>
     <p style="color: red;">⚠️ Будь ласка, змініть пароль в особистому кабінеті!</p>`); res.redirect('/manager/clients');
  }
  catch (e) { console.error(e); res.send("Error reset"); }
};
exports.updateClient = async (req, res) => {
  try {
    const { id, full_name, phone, email } = req.body;

    const [clientData] = await db.query("SELECT bas_guid, barcode FROM clients WHERE id=?", [id]);
    const basGuid = clientData.length > 0 ? clientData[0].bas_guid : null;
    const barcode = clientData.length > 0 ? clientData[0].barcode : '';

    await db.query("UPDATE clients SET full_name=?, phone=?, email=? WHERE id=?", [full_name, phone, email, id]);
    await db.query("UPDATE users SET login=? WHERE id=?", [email, id]);

    res.redirect(`/manager/clients?barcode=${barcode}`);

    if (basGuid) {
      axios.post('http://localhost/base/hs/sync/client', {
        guid: basGuid,
        full_name: full_name,
        email: email,
        phone: phone
      }, {
        auth: { username: 'Адміністратор', password: '' }
      })
        .then(() => console.log(`[BAS] Дані клієнта ${full_name} оновлено в 1С!`))
        .catch(err => console.error('[BAS] Помилка оновлення клієнта:', err.message));
    }
  } catch (e) {
    console.error(e);
    res.send("Error update");
  }
};

exports.searchClientsApi = async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (q.length < 2) return res.json([]);

    const [rows] = await db.query(
      `SELECT id, full_name, barcode, phone 
       FROM clients 
       WHERE full_name LIKE ? OR barcode LIKE ? 
       ORDER BY full_name ASC 
       LIMIT 15`,
      [`%${q}%`, `%${q}%`]
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json([]);
  }
};

exports.addBooking = async (req, res) => {
  try {
    const { trainer_id, client_id, price_id, start_date, start_time, return_url } = req.body;
    const redirectUrl = return_url || `/manager/dashboard?trainer_id=${trainer_id}`;
    const fullDateTime = `${start_date} ${start_time}:00`;
    const { isWithinGymHours } = require('../utils/gymHours');

    if (!isWithinGymHours(start_date, start_time)) {
      return res.send(`<script>alert('Спортзал не працює в цей час! (Пн-Пт: 8-22, Сб: 9-21, Нд: 10-18)'); window.history.back();</script>`);
    }
    const [existing] = await db.query(
      "SELECT id FROM bookings WHERE trainer_id = ? AND start_time = ? AND status = 'scheduled'",
      [trainer_id, fullDateTime]
    );
    if (existing.length > 0) {
      return res.send(`<script>alert('Цей час у тренера вже зайнятий!'); window.location.href='${redirectUrl}';</script>`);
    }

    await db.query(
      `INSERT INTO bookings (client_id, trainer_id, price_id, start_time, end_time, status, payment_status)
       VALUES (?, ?, ?, ?, DATE_ADD(?, INTERVAL 1 HOUR), 'scheduled', 'unpaid')`,
      [client_id, trainer_id, price_id, fullDateTime, fullDateTime]
    );

    res.redirect(redirectUrl);
  } catch (e) {
    console.error(e);
    res.send("Помилка створення запису");
  }
};

exports.updateBooking = async (req, res) => {
  try {
    const { booking_id, trainer_id, new_date, new_time, return_url } = req.body;
    const redirectUrl = return_url || `/manager/dashboard?trainer_id=${trainer_id}`;
    const fullDateTime = `${new_date} ${new_time}:00`;
    const { isWithinGymHours } = require('../utils/gymHours');

    if (!isWithinGymHours(new_date, new_time)) {
      return res.send(`<script>alert('Спортзал не працює в цей час! (Пн-Пт: 8-22, Сб: 9-21, Нд: 10-18)'); window.history.back();</script>`);
    }

    const [existing] = await db.query(
      "SELECT id FROM bookings WHERE trainer_id = ? AND start_time = ? AND status = 'scheduled' AND id != ?",
      [trainer_id, fullDateTime, booking_id]
    );
    if (existing.length > 0) {
      return res.send(`<script>alert('На цей час вже є інший запис!'); window.location.href='${redirectUrl}';</script>`);
    }

    await db.query(
      "UPDATE bookings SET start_time = ?, end_time = DATE_ADD(?, INTERVAL 1 HOUR) WHERE id = ? AND status = 'scheduled'",
      [fullDateTime, fullDateTime, booking_id]
    );

    res.redirect(redirectUrl);
  } catch (e) {
    console.error(e);
    res.send("Помилка оновлення запису");
  }
};
async function recordClientVisit(connection, client_id) {
  const [subs] = await connection.query(`
    SELECT s.id, s.activation_date, s.end_date, p.duration, p.title
    FROM subscriptions s
    JOIN price_list p ON s.price_id = p.id
    WHERE s.client_id = ? AND s.end_date >= CURDATE()
    ORDER BY s.end_date DESC LIMIT 1
  `, [client_id]);

  if (subs.length > 0) {
    const sub = subs[0];
    const [visits] = await connection.query(
      "SELECT COUNT(*) as visit_count FROM visits WHERE client_id = ? AND visit_time >= ?",
      [client_id, sub.activation_date]
    );

    const activationDate = new Date(sub.activation_date);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    activationDate.setHours(0, 0, 0, 0);

    if (visits[0].visit_count === 0 && activationDate < today) {
      const newActivationDate = new Date();
      const newEndDate = new Date();
      const durationStr = (sub.duration || '').toLowerCase();
      const titleStr = (sub.title || '').toLowerCase();

      if (durationStr.includes('рік') || titleStr.includes('рік')) {
        newEndDate.setFullYear(newEndDate.getFullYear() + 1);
      } else if (durationStr.includes('місяць') || titleStr.includes('місяць')) {
        newEndDate.setMonth(newEndDate.getMonth() + 1);
      } else if (durationStr.includes('день') || durationStr.includes('разов') || titleStr.includes('разов')) {
        newEndDate.setDate(newEndDate.getDate() + 1);
      } else {
        newEndDate.setDate(newEndDate.getDate() + 30);
      }

      await connection.query(
        "UPDATE subscriptions SET activation_date = ?, end_date = ? WHERE id = ?",
        [newActivationDate, newEndDate, sub.id]
      );
    }
  }

  await connection.query("INSERT INTO visits (client_id, visit_time) VALUES (?, NOW())", [client_id]);
}

exports.attendBooking = async (req, res) => {
  const { booking_id, trainer_id, payment_method, return_url } = req.body;
  const redirectUrl = return_url || `/manager/dashboard?trainer_id=${trainer_id}`;
  const connection = await db.getConnection();

  try {
    await connection.beginTransaction();

    const [rows] = await connection.query(`
      SELECT b.*, c.bas_guid AS client_guid, c.deposit_balance, p.bas_guid AS service_guid, p.title AS service_title, p.cost
      FROM bookings b
      JOIN clients c ON b.client_id = c.id
      JOIN price_list p ON b.price_id = p.id
      WHERE b.id = ? FOR UPDATE
    `, [booking_id]);

    if (rows.length === 0) {
      await connection.rollback();
      return res.redirect(redirectUrl);
    }

    const booking = rows[0];
    let needBasSale = false;

    if (booking.payment_status === 'unpaid') {
      if (payment_method === 'balance') {
        if (Number(booking.deposit_balance) < Number(booking.cost)) {
          await connection.rollback();
          return res.send(`<script>alert('Недостатньо коштів на балансі клієнта!'); window.location.href='${redirectUrl}';</script>`);
        }
        await connection.query(
          "UPDATE clients SET deposit_balance = deposit_balance - ? WHERE id = ?",
          [booking.cost, booking.client_id]
        );
        await connection.query(
          "UPDATE bookings SET status = 'attended', payment_status = 'paid_from_balance' WHERE id = ?",
          [booking_id]
        );
      } else {
        await connection.query(
          "UPDATE bookings SET status = 'attended', payment_status = 'paid_at_desk' WHERE id = ?",
          [booking_id]
        );
        needBasSale = true;
      }
    } else {
      await connection.query("UPDATE bookings SET status = 'attended' WHERE id = ?", [booking_id]);
    }
    await recordClientVisit(connection, booking.client_id);

    await connection.commit();
    res.redirect(redirectUrl);

    if (needBasSale && booking.client_guid) {
      axios.post('http://localhost/base/hs/sync/sale', {
        client_guid: booking.client_guid,
        service_guid: booking.service_guid,
        service_title: booking.service_title,
        sum: booking.cost,
        payment_method: payment_method
      }, {
        auth: { username: 'Адміністратор', password: '' }
      })
        .then(async (basResponse) => {
          if (basResponse.data && basResponse.data.bas_doc_guid) {
            await db.query("UPDATE bookings SET bas_doc_guid = ? WHERE id = ?", [basResponse.data.bas_doc_guid, booking_id]);
            console.log(`[BAS] Оплата тренування #${booking_id} проведена. GUID: ${basResponse.data.bas_doc_guid}`);
          }
        })
        .catch(err => console.error('[BAS] Помилка вивантаження оплати тренування:', err.message));
    }

  } catch (e) {
    await connection.rollback();
    console.error(e);
    res.send("Помилка відмітки візиту");
  } finally {
    connection.release();
  }
};

exports.cancelBooking = async (req, res) => {
  const { booking_id, trainer_id, return_url } = req.body;
  const redirectUrl = return_url || `/manager/dashboard?trainer_id=${trainer_id}`;
  const connection = await db.getConnection();

  try {
    await connection.beginTransaction();

    const [rows] = await connection.query(`
      SELECT b.status, b.payment_status, b.client_id, p.cost
      FROM bookings b
      JOIN price_list p ON b.price_id = p.id
      WHERE b.id = ? FOR UPDATE
    `, [booking_id]);

    if (rows.length > 0 && rows[0].status === 'scheduled') {
      const booking = rows[0];
      await connection.query("UPDATE bookings SET status = 'cancelled_by_manager' WHERE id = ?", [booking_id]);

      if (booking.payment_status !== 'unpaid') {
        await connection.query(
          "UPDATE clients SET deposit_balance = deposit_balance + ? WHERE id = ?",
          [booking.cost, booking.client_id]
        );
      }
    }

    await connection.commit();
    res.redirect(redirectUrl);
  } catch (e) {
    await connection.rollback();
    console.error(e);
    res.send("Помилка скасування запису");
  } finally {
    connection.release();
  }
};
exports.getTrainersPage = async (req, res) => {
  try {
    const [trainers] = await db.query("SELECT * FROM trainers ORDER BY full_name");
    res.render('manager_trainers', {
      user: req.session.user,
      trainers
    });
  } catch (e) { console.error(e); res.send("Error loading trainers"); }
};

exports.updateTrainer = async (req, res) => {
  const { id, email, phone, experience, description, new_password } = req.body;
  const photo = req.file ? req.file.buffer : null;
  const connection = await db.getConnection();

  try {
    await connection.beginTransaction();

    const [trainerData] = await connection.query("SELECT full_name, bas_guid FROM trainers WHERE id = ?", [id]);
    const fullName = trainerData.length > 0 ? trainerData[0].full_name : '';
    const basGuid = trainerData.length > 0 ? trainerData[0].bas_guid : null;

    await connection.query(
      "UPDATE trainers SET email=?, phone=?, experience=?, description=? WHERE id=?",
      [email, phone, experience, description, id]
    );

    if (photo) {
      await connection.query("UPDATE trainers SET photo=? WHERE id=?", [photo, id]);
    }

    await connection.query("UPDATE users SET login=? WHERE id=?", [email, id]);

    if (new_password && new_password.trim() !== "") {
      const hashedPassword = await bcrypt.hash(new_password, 10);
      await connection.query("UPDATE users SET password=? WHERE id=?", [hashedPassword, id]);
    }

    await connection.commit();
    res.redirect('/manager/trainers'); 

    if (basGuid) {
      let photoBase64 = null;
      if (photo) {
        photoBase64 = photo.toString('base64').replace(/(\r\n|\n|\r)/gm, "");
      }

      axios.post('http://localhost/base/hs/sync/trainer', {
        guid: basGuid,
        full_name: fullName,
        email: email,
        phone: phone,
        experience: experience,
        description: description,
        photo_base64: photoBase64
      }, {
        auth: { username: 'Адміністратор', password: '' }
      })
        .then((basResponse) => {
          console.log(`[BAS] Дані вивантажено! ЛОГ З 1С:`, basResponse.data.log);
        })
        .catch(basError => {
          const errorData = basError.response && basError.response.data ? basError.response.data : {};
          console.error('[BAS] ПОМИЛКА 1С:', errorData.error || basError.message);
          console.error('[BAS] Останній крок перед падінням:', errorData.log_before_crash || 'Невідомо');
        });
    } else {
      console.log(`[BAS] У тренера ${fullName} відсутній bas_guid, синхронізацію пропущено.`);
    }

  } catch (error) {
    await connection.rollback();
    console.error(error);
    res.send("Помилка редагування тренера");
  } finally {
    connection.release();
  }
};

exports.searchTrainersApi = async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    const [rows] = await db.query(
      `SELECT id, full_name FROM trainers 
       WHERE is_active = 1 AND full_name LIKE ? 
       ORDER BY full_name ASC LIMIT 15`,
      [`%${q}%`]
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json([]);
  }
};

exports.registerVisit = async (req, res) => {
  try {
    const { client_id, return_url } = req.body;
    await recordClientVisit(db, client_id);
    res.redirect(return_url || '/manager/clients');
  } catch (error) {
    console.error("Помилка фіксації візиту:", error);
    res.send("Помилка фіксації візиту.");
  }
};
exports.topupBalance = async (req, res) => {
  try {
    const { client_id, amount, payment_method, return_url } = req.body;
    const sum = Number(amount);

    if (!sum || sum <= 0) {
      return res.send(`<script>alert('Сума має бути більшою за 0!'); window.history.back();</script>`);
    }

    await db.query(
      "UPDATE clients SET deposit_balance = deposit_balance + ? WHERE id = ?",
      [sum, client_id]
    );

    const [clientRows] = await db.query("SELECT barcode, bas_guid FROM clients WHERE id = ?", [client_id]);
    const barcode = clientRows.length > 0 ? clientRows[0].barcode : '';
    const basGuid = clientRows.length > 0 ? clientRows[0].bas_guid : null;

    res.redirect(return_url || `/manager/clients?barcode=${barcode}`);

    if (basGuid) {
      axios.post('http://localhost/base/hs/sync/sale', {
        action_type: 'payment_only',
        client_guid: basGuid,
        service_guid: null,
        service_title: 'Поповнення депозиту / погашення боргу',
        sum: sum,
        payment_method: payment_method
      }, {
        auth: { username: 'Адміністратор', password: '' }
      })
        .then(() => console.log(`[BAS] Поповнення балансу на ${sum} грн вивантажено в 1С.`))
        .catch(err => console.error('[BAS] Помилка вивантаження поповнення балансу:', err.response?.data || err.message));
    }
  } catch (e) {
    console.error(e);
    res.send("Помилка поповнення балансу");
  }
};

exports.getReportsPage = async (req, res) => {
  try {
    const today = new Date();
    const firstDay = new Date(today.getFullYear(), today.getMonth(), 1).toLocaleDateString('en-CA');
    const lastDay = today.toLocaleDateString('en-CA');

    const startDate = req.query.startDate || firstDay;
    const endDate = req.query.endDate || lastDay;
    const trainerRate = 200;

    const [[subFinance]] = await db.query(`
      SELECT
        COALESCE(SUM(p.cost), 0) AS total_sum,
        COALESCE(SUM(CASE WHEN s.payment_method = 'cash' THEN p.cost ELSE 0 END), 0) AS cash_sum,
        COALESCE(SUM(CASE WHEN s.payment_method != 'cash' OR s.payment_method IS NULL THEN p.cost ELSE 0 END), 0) AS card_sum,
        COUNT(s.id) AS total_count
      FROM subscriptions s
      JOIN price_list p ON s.price_id = p.id
      WHERE DATE(s.purchase_date) BETWEEN ? AND ?
    `, [startDate, endDate]);

    const [[bookingFinance]] = await db.query(`
      SELECT
        COALESCE(SUM(p.cost), 0) AS total_sum,
        COUNT(b.id) AS total_count
      FROM bookings b
      JOIN price_list p ON b.price_id = p.id
      WHERE DATE(b.start_time) BETWEEN ? AND ?
        AND b.payment_status != 'unpaid'
        AND b.status NOT IN ('cancelled_by_client', 'cancelled_by_manager')
    `, [startDate, endDate]);

    const finance = {
      total_sum: (Number(subFinance.total_sum) + Number(bookingFinance.total_sum)).toFixed(2),
      cash_sum: Number(subFinance.cash_sum).toFixed(2),
      card_sum: Number(subFinance.card_sum).toFixed(2),
      sales_sum: Number(subFinance.total_sum).toFixed(2),
      trainings_sum: Number(bookingFinance.total_sum).toFixed(2),
      total_count: Number(subFinance.total_count) + Number(bookingFinance.total_count)
    };

    const [trainersRaw] = await db.query(`
      SELECT
        t.id,
        t.full_name,
        SUM(CASE WHEN b.status = 'attended' THEN 1 ELSE 0 END) AS attended_count,
        SUM(CASE WHEN b.status = 'no_show' THEN 1 ELSE 0 END) AS no_show_count,
        SUM(CASE WHEN b.status IN ('cancelled_by_client', 'cancelled_by_manager') THEN 1 ELSE 0 END) AS cancelled_count
      FROM trainers t
      LEFT JOIN bookings b 
        ON t.id = b.trainer_id 
        AND DATE(b.start_time) BETWEEN ? AND ?
      GROUP BY t.id, t.full_name
      ORDER BY attended_count DESC
    `, [startDate, endDate]);

    const trainersReport = trainersRaw.map(t => {
      const attended = Number(t.attended_count || 0);
      const noShow = Number(t.no_show_count || 0);
      return {
        ...t,
        attended_count: attended,
        no_show_count: noShow,
        cancelled_count: Number(t.cancelled_count || 0),
        salary_estimate: ((attended + noShow) * trainerRate).toFixed(2)
      };
    });

    const [expiringRaw] = await db.query(`
      SELECT c.full_name, c.phone, p.title AS sub_title, s.end_date
      FROM subscriptions s
      JOIN clients c ON s.client_id = c.id
      JOIN price_list p ON s.price_id = p.id
      WHERE s.end_date BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 7 DAY)
      ORDER BY s.end_date ASC
    `);

    const expiringSubs = expiringRaw.map(s => ({
      ...s,
      end_date_str: new Date(s.end_date).toLocaleDateString('uk-UA')
    }));

    const [debtorsRaw] = await db.query(`
      SELECT full_name, phone, deposit_balance
      FROM clients
      WHERE deposit_balance < 0
      ORDER BY deposit_balance ASC
    `);

    const debtors = debtorsRaw.map(d => ({
      ...d,
      balance_str: Number(d.deposit_balance).toFixed(2)
    }));

    const [topServicesRaw] = await db.query(`
      SELECT 
        p.title,
        COUNT(s.id) AS sales_count,
        COALESCE(SUM(p.cost), 0) AS total_revenue
      FROM subscriptions s
      JOIN price_list p ON s.price_id = p.id
      WHERE DATE(s.purchase_date) BETWEEN ? AND ?
      GROUP BY p.id, p.title
      ORDER BY total_revenue DESC
    `, [startDate, endDate]);

    const topServices = topServicesRaw.map(srv => ({
      ...srv,
      revenue_str: Number(srv.total_revenue || 0).toFixed(2)
    }));

    const [hourlyRaw] = await db.query(`
      SELECT 
        HOUR(start_time) AS hour_of_day,
        COUNT(id) AS bookings_count
      FROM bookings
      WHERE DATE(start_time) BETWEEN ? AND ?
        AND status IN ('attended', 'scheduled')
      GROUP BY HOUR(start_time)
      ORDER BY hour_of_day ASC
    `, [startDate, endDate]);

    const maxBookings = Math.max(...hourlyRaw.map(h => h.bookings_count), 1);
    const hourlyLoad = hourlyRaw.map(h => ({
      hour_label: `${String(h.hour_of_day).padStart(2, '0')}:00`,
      bookings_count: h.bookings_count,
      percent: Math.round((h.bookings_count / maxBookings) * 100)
    }));

    res.render('manager_reports', {
      title: 'Звіти та аналітика',
      user: req.session.user,
      startDate,
      endDate,
      finance,
      trainersReport,
      expiringSubs,
      debtors,
      topServices,
      hourlyLoad
    });
  } catch (err) {
    console.error('Помилка формування звітів:', err);
    res.status(500).send('Помилка завантаження звітів');
  }
};