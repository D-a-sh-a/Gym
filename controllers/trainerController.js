const db = require('../database/db');
exports.getDashboard = async (req, res, db) => {
    try {
        const trainerId = req.session.user.id;
        const sql = `
            SELECT b.id, b.start_time, c.full_name AS client_name, p.title AS service
            FROM bookings b
            JOIN clients c ON b.client_id = c.id
            JOIN price_list p ON b.price_id = p.id
            WHERE b.trainer_id = ?
        `;
        const [bookings] = await db.query(sql, [trainerId]);
        const events = bookings.map(booking => {
            const startDate = new Date(booking.start_time);
            const endDate = new Date(startDate.getTime() + 60 * 60000);
            const pad = (num) => String(num).padStart(2, '0');
            const dateStr = `${startDate.getFullYear()}-${pad(startDate.getMonth() + 1)}-${pad(startDate.getDate())}`;
            const timeStr = `${pad(startDate.getHours())}:${pad(startDate.getMinutes())}`;
            return {
                id: booking.id,
                title: `${booking.client_name}\n(${booking.service})`,
                start: startDate.toISOString(),
                end: endDate.toISOString(),
                color: '#2ECC71',
                textColor: '#FFFFFF',
                extendedProps: {
                    client: booking.client_name,
                    service: booking.service,
                    dateOnly: dateStr,
                    timeOnly: timeStr
                }
            };
        });
        const [clients] = await db.query("SELECT id, full_name FROM clients ORDER BY full_name");
        const [prices] = await db.query("SELECT id, title FROM price_list WHERE title LIKE '%Персональне%' LIMIT 1");
        const personalTraining = prices.length > 0 ? prices[0] : { id: 1, title: 'Тренування' };
        res.render('trainer_dashboard', {
            user: req.session.user,
            eventsJson: JSON.stringify(events),
            clientsList: clients,
            fixedService: personalTraining
        });
    } catch (error) {
        console.error(error);
        res.send("Помилка при завантаженні розкладу");
    }
};

exports.addBooking = async (req, res, db) => {
    try {
        const trainerId = req.session.user.id;
        const { client_id, start_date, start_time, price_id } = req.body;
        const fullDateTime = `${start_date} ${start_time}:00`;
        const [existing] = await db.query(
            "SELECT id FROM bookings WHERE trainer_id = ? AND start_time = ?",
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
            "INSERT INTO bookings (client_id, trainer_id, start_time, price_id) VALUES (?, ?, ?, ?)",
            [client_id, trainerId, fullDateTime, price_id]
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
        const [existing] = await db.query(
            "SELECT id FROM bookings WHERE trainer_id = ? AND start_time = ? AND id != ?",
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
        await db.query('UPDATE bookings SET start_time = ? WHERE id = ?', [formattedFullTime, booking_id]);
        res.redirect('/trainer/dashboard');
    } catch (error) {
        console.error(error);
        res.send("Помилка редагування");
    }
};

exports.deleteBooking = async (req, res, db) => {
    try {
        const { booking_id } = req.body;
        await db.query('DELETE FROM bookings WHERE id = ?', [booking_id]);
        res.redirect('/trainer/dashboard');
    } catch (error) {
        console.error(error);
        res.send("Помилка видалення");
    }
};