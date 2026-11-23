const db = require('../database/db');

exports.getDashboard = async (req, res, db) => {
    try {
        const trainerId = req.session.user.id;
        const sql = `
            SELECT b.id, b.start_time, b.end_time, b.status, b.payment_status,
                   c.full_name AS client_name, c.phone AS client_phone,
                   p.title AS service, p.cost
            FROM bookings b
            JOIN clients c ON b.client_id = c.id
            JOIN price_list p ON b.price_id = p.id
            WHERE b.trainer_id = ?
              AND b.status NOT IN ('cancelled_by_client', 'cancelled_by_manager')
        `;
        const [bookings] = await db.query(sql, [trainerId]);

        const events = bookings.map(b => {
            const startDate = new Date(b.start_time);
            const endDate = b.end_time ? new Date(b.end_time) : new Date(startDate.getTime() + 60 * 60000);
            const isPaid = b.payment_status !== 'unpaid';

            let color = '#F39C12';
            if (b.status === 'attended') color = '#198754';
            else if (b.status === 'no_show') color = '#DC3545';
            else if (isPaid) color = '#2ECC71';

            const pad = (num) => String(num).padStart(2, '0');
            const dateStr = `${startDate.getFullYear()}-${pad(startDate.getMonth() + 1)}-${pad(startDate.getDate())}`;
            const timeStr = `${pad(startDate.getHours())}:${pad(startDate.getMinutes())}`;

            return {
                id: b.id,
                title: `${isPaid ? '✅' : '💳'} ${b.client_name}`,
                start: startDate.toISOString(),
                end: endDate.toISOString(),
                color: color,
                textColor: '#FFFFFF',
                extendedProps: {
                    client: b.client_name,
                    phone: b.client_phone || '',
                    service: b.service,
                    cost: Number(b.cost || 0),
                    status: b.status,
                    paymentStatus: b.payment_status,
                    dateOnly: dateStr,
                    timeOnly: timeStr
                }
            };
        });

        const [prices] = await db.query("SELECT id, title, cost FROM price_list WHERE LOWER(title) LIKE '%персональн%' LIMIT 1");
        const personalTraining = prices.length > 0 ? prices[0] : { id: 1, title: 'Персональне тренування', cost: 0 };

        res.render('trainer_dashboard', {
            user: req.session.user,
            eventsJson: JSON.stringify(events),
            fixedService: personalTraining
        });
    } catch (error) {
        console.error(error);
        res.send("Помилка при завантаженні розкладу");
    }
};

exports.searchClientsApi = async (req, res, db) => {
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

exports.addBooking = async (req, res, db) => {
    try {
        const trainerId = req.session.user.id;
        const { client_id, start_date, start_time, price_id } = req.body;
        const fullDateTime = `${start_date} ${start_time}:00`;
        const { isWithinGymHours } = require('../utils/gymHours');

    if (!isWithinGymHours(start_date, start_time)) {
      return res.send(`<script>alert('Спортзал не працює в цей час! (Пн-Пт: 8-22, Сб: 9-21, Нд: 10-18)'); window.history.back();</script>`);
    }

        const [existing] = await db.query(
            "SELECT id FROM bookings WHERE trainer_id = ? AND start_time = ? AND status = 'scheduled'",
            [trainerId, fullDateTime]
        );
        if (existing.length > 0) {
            return res.send(`
                <script>
                    alert('⚠️ ПОМИЛКА: Час ${start_time} на дату ${start_date} вже зайнятий!');
                    window.location.href = '/trainer/dashboard';
                </script>
            `);
        }

        await db.query(
            `INSERT INTO bookings (client_id, trainer_id, price_id, start_time, end_time, status, payment_status)
             VALUES (?, ?, ?, ?, DATE_ADD(?, INTERVAL 1 HOUR), 'scheduled', 'unpaid')`,
            [client_id, trainerId, price_id, fullDateTime, fullDateTime]
        );
        res.redirect('/trainer/dashboard');
    } catch (error) {
        console.error(error);
        res.send("Помилка при створенні запису");
    }
};

exports.updateBooking = async (req, res, db) => {
    try {
        const trainerId = req.session.user.id;
        const { booking_id, new_date, new_time } = req.body;
        const formattedFullTime = `${new_date} ${new_time}:00`;
        const { isWithinGymHours } = require('../utils/gymHours');

    if (!isWithinGymHours(start_date, start_time)) {
      return res.send(`<script>alert('Спортзал не працює в цей час! (Пн-Пт: 8-22, Сб: 9-21, Нд: 10-18)'); window.history.back();</script>`);
    }

        const [existing] = await db.query(
            "SELECT id FROM bookings WHERE trainer_id = ? AND start_time = ? AND status = 'scheduled' AND id != ?",
            [trainerId, formattedFullTime, booking_id]
        );
        if (existing.length > 0) {
            return res.send(`
                <script>
                    alert('⚠️ ПОМИЛКА: На час ${new_time} (${new_date}) вже є інший запис! Оберіть інший.');
                    window.location.href = '/trainer/dashboard';
                </script>
            `);
        }

        await db.query(
            "UPDATE bookings SET start_time = ?, end_time = DATE_ADD(?, INTERVAL 1 HOUR) WHERE id = ? AND trainer_id = ? AND status = 'scheduled'",
            [formattedFullTime, formattedFullTime, booking_id, trainerId]
        );
        res.redirect('/trainer/dashboard');
    } catch (error) {
        console.error(error);
        res.send("Помилка редагування");
    }
};

exports.deleteBooking = async (req, res, db) => {
    const trainerId = req.session.user.id;
    const { booking_id } = req.body;
    const connection = await db.getConnection();

    try {
        await connection.beginTransaction();

        const [rows] = await connection.query(`
            SELECT b.status, b.payment_status, b.client_id, p.cost
            FROM bookings b
            JOIN price_list p ON b.price_id = p.id
            WHERE b.id = ? AND b.trainer_id = ? FOR UPDATE
        `, [booking_id, trainerId]);

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
        res.redirect('/trainer/dashboard');
    } catch (error) {
        await connection.rollback();
        console.error(error);
        res.send("Помилка скасування запису");
    } finally {
        connection.release();
    }
};