const db = require('../database/db');
const bcrypt = require('bcrypt');
const mailer = require('../utils/mailer');
const { v4: uuidv4 } = require('uuid');

exports.getDashboard = async (req, res) => {
  try {
    const selectedTrainerId = req.query.trainer_id;
    let events = [];
    if (selectedTrainerId) {
      const sql = `
                SELECT b.id, b.start_time, c.full_name AS client_name, t.full_name AS trainer_name, p.title AS service
                FROM bookings b
                JOIN clients c ON b.client_id = c.id
                JOIN trainers t ON b.trainer_id = t.id
                JOIN price_list p ON b.price_id = p.id
                WHERE b.trainer_id = ?
            `;
      const [bookings] = await db.query(sql, [selectedTrainerId]);
      events = bookings.map(b => {
        const start = new Date(b.start_time);
        return {
          id: b.id,
          title: `${b.client_name}\n(${b.service})`,
          start: start.toISOString(),
          end: new Date(start.getTime() + 60 * 60000).toISOString(),
          color: '#2ECC71',
          textColor: '#FFFFFF',
          extendedProps: {
            client: b.client_name,
            trainer: b.trainer_name,
            service: b.service,
            dateOnly: start.toISOString().split('T')[0],
            timeOnly: start.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' })
          }
        };
      });
    }
    const [trainers] = await db.query("SELECT id, full_name FROM trainers");
    const [clients] = await db.query("SELECT id, full_name FROM clients ORDER BY full_name");
    const [prices] = await db.query("SELECT id, title FROM price_list");
    res.render('manager_dashboard', {
      user: req.session.user,
      eventsJson: JSON.stringify(events),
      trainersList: trainers,
      clientsList: clients,
      pricesList: prices,
      selectedTrainerId: selectedTrainerId ? Number(selectedTrainerId) : null
    });
  } catch (error) {
    console.error(error);
    res.send("Помилка дашборда");
  }
};

exports.getClientsPage = async (req, res) => {
  try {
    const searchQuery = req.query.search || '';
    let sql = `
            SELECT c.*, 
            (SELECT p.title FROM subscriptions s JOIN price_list p ON s.price_id = p.id WHERE s.client_id = c.id ORDER BY s.end_date DESC LIMIT 1) as sub_title,
            (SELECT s.end_date FROM subscriptions s WHERE s.client_id = c.id ORDER BY s.end_date DESC LIMIT 1) as sub_date
            FROM clients c
        `;
    const params = [];
    if (searchQuery) {
      sql += " WHERE c.full_name LIKE ?";
      params.push(`%${searchQuery}%`);
    }
    sql += " ORDER BY c.full_name ASC";
    const [clientsRaw] = await db.query(sql, params);
    const [prices] = await db.query("SELECT * FROM price_list WHERE title LIKE '%абонемент%' OR duration LIKE '%місяць%' OR duration LIKE '%рік%'");
    const today = new Date();
    const nextWeek = new Date();
    nextWeek.setDate(today.getDate() + 7);
    const clients = clientsRaw.map(client => {
      let status = { text: 'Немає активного абонементу', class: 'secondary', is_active: false };
      let formattedDate = '';
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
          formattedDate = dateStr;
        }
      }
      return {
        ...client,
        subscription_status: status,
        sub_title_display: status.is_active ? client.sub_title : ''
      };
    });
    res.render('manager_clients', {
      user: req.session.user,
      clients,
      prices,
      searchQuery
    });
  } catch (e) { console.error(e); res.send("Error"); }
};

exports.sellSubscription = async (req, res) => {
  try {
    const { client_id, price_id } = req.body;
    const [priceData] = await db.query("SELECT duration FROM price_list WHERE id = ?", [price_id]);
    const durationStr = priceData[0].duration.toLowerCase();
    const [activeSub] = await db.query(
      "SELECT end_date FROM subscriptions WHERE client_id = ? AND end_date >= CURDATE() ORDER BY end_date DESC LIMIT 1",
      [client_id]
    );
    let startDate = new Date();
    if (activeSub.length > 0) {
      const currentEndDate = new Date(activeSub[0].end_date);
      startDate = new Date(currentEndDate);
      startDate.setDate(startDate.getDate() + 1);
    }
    const endDate = new Date(startDate);
    if (durationStr.includes('рік')) {
      endDate.setFullYear(endDate.getFullYear() + 1);
    } else if (durationStr.includes('місяць')) {
      endDate.setMonth(endDate.getMonth() + 1);
      if (startDate.getDate() !== endDate.getDate()) {
        endDate.setDate(0);
      }
    } else {
      endDate.setDate(endDate.getDate() + 30);
    }
    await db.query("INSERT INTO subscriptions (client_id, price_id, start_date, end_date) VALUES (?, ?, ?, ?)",
      [client_id, price_id, startDate, endDate]);

    res.redirect('/manager/clients');
  } catch (e) {
    console.error(e);
    res.send("Помилка при продажі абонемента");
  }
};

exports.registerClient = async (req, res) => {
  const { full_name, email, phone, birth_date } = req.body;
  const connection = await db.getConnection();
  try { await connection.beginTransaction();
    const rawPassword = uuidv4().slice(0, 8);
    const hashedPassword = await bcrypt.hash(rawPassword, 10);
    const [uRes] = await connection.query("INSERT INTO users (login, password, role) VALUES (?, ?, 'client')", [email, hashedPassword]); 
    await connection.query("INSERT INTO clients (id, full_name, phone, email, birth_date) VALUES (?, ?, ?, ?, ?)", [uRes.insertId, full_name, phone, email, birth_date]); 
    await connection.commit(); 
    mailer.sendMail(email, "Реєстрація в GYM", `<h2>Вітаємо!</h2>
     <p>Ваш логін: <strong>${email}</strong></p>
     <p>Ваш пароль: <strong>${rawPassword}</strong></p>
     <hr>
     <p style="color: red;">⚠️ Обов'язково змініть цей пароль в особистому кабінеті!</p>
     <a href="http://localhost:3000/login">Увійти в кабінет</a>`); 
    res.redirect('/manager/clients'); } 
    catch (error) { await connection.rollback(); console.error(error); res.send("Помилка реєстрації."); } 
    finally { connection.release(); }
};
exports.resetPassword = async (req, res) => { 
  try { 
    const { client_id, client_email } = req.body;
    const newPass = uuidv4().slice(0, 8);
    const hashed = await bcrypt.hash(newPass, 10);
    await db.query("UPDATE users SET password = ? WHERE id = ?", [hashed, client_id]); 
    mailer.sendMail(client_email, "Скидання пароля", `<h3>Ваш пароль було скинуто</h3>
     <p>Новий пароль: <strong>${newPass}</strong></p>
     <p style="color: red;">⚠️ Будь ласка, змініть пароль в особистому кабінеті!</p>`); res.redirect('/manager/clients'); } 
    catch (e) { console.error(e); res.send("Error reset"); } };
exports.updateClient = async (req, res) => { 
  try { 
    const { id, full_name, phone, email } = req.body; 
    await db.query("UPDATE clients SET full_name=?, phone=?, email=? WHERE id=?", [full_name, phone, email, id]); 
    await db.query("UPDATE users SET login=? WHERE id=?", [email, id]); res.redirect('/manager/clients'); } 
    catch (e) { console.error(e); res.send("Error update"); } };
exports.addBooking = async (req, res) => { 
  try { 
    const { trainer_id, client_id, price_id, start_date, start_time } = req.body; 
    const fullDateTime = `${start_date} ${start_time}:00`; 
    const [existing] = await db.query("SELECT id FROM bookings WHERE trainer_id = ? AND start_time = ?", [trainer_id, fullDateTime]); 
    if (existing.length > 0) return res.send(`<script>alert('Зайнято!');window.location.href='/manager/dashboard';</script>`); 
    await db.query("INSERT INTO bookings (client_id, trainer_id, price_id, start_time) VALUES (?, ?, ?, ?)", [client_id, trainer_id, price_id, fullDateTime]); 
    res.redirect('/manager/dashboard'); } 
    catch (e) { console.error(e); res.send("Error"); } };
exports.deleteBooking = async (req, res) => { 
  try { 
    await db.query("DELETE FROM bookings WHERE id = ?", [req.body.booking_id]);
    res.redirect('/manager/dashboard'); } 
    catch (e) { console.error(e); res.send("Error"); } };
exports.updateBooking = async (req, res) => { 
  try { 
    const { booking_id, new_date, new_time } = req.body; 
    const fullDateTime = `${new_date} ${new_time}:00`; 
    await db.query("UPDATE bookings SET start_time = ? WHERE id = ?", [fullDateTime, booking_id]); 
    res.redirect('/manager/dashboard'); } 
    catch (e) { console.error(e); res.send("Error"); } };
exports.getTrainersPage = async (req, res) => {
  try {
    const [trainers] = await db.query("SELECT * FROM trainers ORDER BY full_name");
    res.render('manager_trainers', {
      user: req.session.user,
      trainers
    });
  } catch (e) { console.error(e); res.send("Error loading trainers"); }
};
exports.createTrainer = async (req, res) => {
    const { full_name, email, phone, experience, description, password } = req.body;
    const photo = req.file ? req.file.buffer : null; // Отримуємо фото (або null)
    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();
        const hashedPassword = await bcrypt.hash(password, 10);
        const [uRes] = await connection.query(
            "INSERT INTO users (login, password, role) VALUES (?, ?, 'trainer')", 
            [email, hashedPassword]
        );
        await connection.query(
            "INSERT INTO trainers (id, full_name, phone, email, experience, description, photo) VALUES (?, ?, ?, ?, ?, ?, ?)", 
            [uRes.insertId, full_name, phone, email, experience, description, photo]
        );
        await connection.commit();
        res.redirect('/manager/trainers');
    } catch (error) {
        await connection.rollback();
        console.error(error);
        res.send("Помилка створення тренера. Перевірте дані.");
    } finally {
        connection.release();
    }
};
exports.updateTrainer = async (req, res) => {
    const { id, full_name, email, phone, experience, description, new_password } = req.body;
    const photo = req.file ? req.file.buffer : null;
    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();
        await connection.query(
            "UPDATE trainers SET full_name=?, email=?, phone=?, experience=?, description=? WHERE id=?", 
            [full_name, email, phone, experience, description, id]
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
    } catch (error) {
        await connection.rollback();
        console.error(error);
        res.send("Помилка редагування");
    } finally {
        connection.release();
    }
};
exports.deleteTrainer = async (req, res) => {
    try {
        const { id } = req.body;
        await db.query("DELETE FROM users WHERE id = ?", [id]);
        res.redirect('/manager/trainers');
    } catch (e) { console.error(e); res.send("Error deleting trainer"); }
};