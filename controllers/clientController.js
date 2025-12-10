const db = require('../database/db'); 
const bcrypt = require('bcrypt');

exports.getDashboard = async (req, res, db) => {
    try {
        const clientId = req.session.user.id;
        const sql = `
            SELECT b.id, b.start_time, t.full_name AS trainer_name, p.title AS service
            FROM bookings b
            JOIN trainers t ON b.trainer_id = t.id
            JOIN price_list p ON b.price_id = p.id
            WHERE b.client_id = ?
        `;
        const [bookings] = await db.query(sql, [clientId]);
        const events = bookings.map(booking => {
            const startDate = new Date(booking.start_time);
            const endDate = new Date(startDate.getTime() + 60 * 60000);
            return {
                id: booking.id,
                title: `${booking.trainer_name}\n(${booking.service})`,
                start: startDate.toISOString(),
                end: endDate.toISOString(),
                color: '#2ECC71',
                textColor: '#FFFFFF',
                extendedProps: {
                    trainer: booking.trainer_name,
                    service: booking.service
                }
            };
        });
        res.render('client_dashboard', {
            user: req.session.user,
            eventsJson: JSON.stringify(events)
        });
    } catch (error) {
        console.error(error);
        res.send("Помилка при завантаженні кабінету");
    }
};

exports.getProfile = async (req, res, db) => {
    try {
        const clientId = req.session.user.id;
        const [clientData] = await db.query("SELECT full_name, email FROM clients WHERE id = ?", [clientId]);
        const client = clientData[0];
        let subscription = null;
        const [subs] = await db.query(`
            SELECT s.end_date, p.title 
            FROM subscriptions s
            JOIN price_list p ON s.price_id = p.id
            WHERE s.client_id = ? AND s.end_date >= CURDATE()
            ORDER BY s.end_date DESC LIMIT 1
        `, [clientId]);
        if (subs.length > 0) {
            subscription = {
                title: subs[0].title,
                date: new Date(subs[0].end_date).toLocaleDateString('uk-UA')
            };
        }
        res.render('client_profile', {
            user: req.session.user,
            clientInfo: client,
            subscription: subscription
        });
    } catch (error) {
        console.error(error);
        res.send("Помилка завантаження профілю");
    }
};

exports.changePassword = async (req, res, db) => {
    try {
        const userId = req.session.user.id;
        const { new_password, confirm_password } = req.body;
        if (new_password !== confirm_password) {
            return res.send(`<script>alert('❌ Паролі не співпадають!'); window.location.href='/client/profile';</script>`);
        }
        const hashedPassword = await bcrypt.hash(new_password, 10);
        await db.query("UPDATE users SET password = ? WHERE id = ?", [hashedPassword, userId]);
        res.send(`<script>alert('✅ Пароль успішно змінено!'); window.location.href='/client/profile';</script>`);
    } catch (error) {
        console.error(error);
        res.send("Помилка зміни пароля");
    }
};