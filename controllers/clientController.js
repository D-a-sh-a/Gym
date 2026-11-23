const db = require('../database/db');
const bcrypt = require('bcrypt');
const axios = require('axios');
axios.defaults.headers.common['ngrok-skip-browser-warning'] = 'true';

const CANCEL_FREE_HOURS = 12;

exports.getDashboard = async (req, res, db) => {
    try {
        const clientId = req.session.user.id;

        const [clientRows] = await db.query("SELECT deposit_balance FROM clients WHERE id = ?", [clientId]);
        const depositBalance = clientRows.length > 0 ? Number(clientRows[0].deposit_balance || 0) : 0;

        const sql = `
            SELECT b.id, b.trainer_id, b.start_time, b.end_time, b.status, b.payment_status,
                   t.full_name AS trainer_name, p.title AS service, p.cost
            FROM bookings b
            JOIN trainers t ON b.trainer_id = t.id
            JOIN price_list p ON b.price_id = p.id
            WHERE b.client_id = ?
              AND b.status NOT IN ('cancelled_by_client', 'cancelled_by_manager')
        `;
        const [bookings] = await db.query(sql, [clientId]);

        const events = bookings.map(b => {
            const startDate = new Date(b.start_time);
            const endDate = b.end_time ? new Date(b.end_time) : new Date(startDate.getTime() + 60 * 60000);
            const isPaid = b.payment_status !== 'unpaid';

            let color = '#F39C12';
            if (b.status === 'attended') color = '#198754';
            else if (b.status === 'no_show') color = '#DC3545';
            else if (isPaid) color = '#2ECC71';

            return {
                id: b.id,
                title: `${isPaid ? '✅' : '💳'} ${b.trainer_name}`,
                start: startDate.toISOString(),
                end: endDate.toISOString(),
                color: color,
                textColor: '#FFFFFF',
                extendedProps: {
                    trainerId: b.trainer_id,
                    trainer: b.trainer_name,
                    service: b.service,
                    cost: Number(b.cost || 0),
                    status: b.status,
                    paymentStatus: b.payment_status,
                    dateOnly: startDate.toLocaleDateString('en-CA'),
                    timeOnly: startDate.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' })
                }
            };
        });

        const [trainers] = await db.query("SELECT id, full_name FROM trainers WHERE is_active = 1 ORDER BY full_name");
        const [prices] = await db.query("SELECT id, title, cost FROM price_list WHERE LOWER(title) LIKE '%персональн%'");

        res.render('client_dashboard', {
            user: req.session.user,
            eventsJson: JSON.stringify(events),
            trainersList: trainers,
            pricesList: prices,
            depositBalance: depositBalance
        });
    } catch (error) {
        console.error(error);
        res.send("Помилка при завантаженні кабінету");
    }
};

exports.getAvailableSlots = async (req, res) => {
    try {
        const { trainer_id, date } = req.query;
        if (!trainer_id || !date) return res.json([]);

        const [schedule] = await db.query(
            "SELECT start_time, end_time FROM trainer_schedules WHERE trainer_id = ? AND work_date = ?",
            [trainer_id, date]
        );

        if (schedule.length === 0) {
            return res.json([]);
        }

        const startHour = parseInt(schedule[0].start_time.split(':')[0], 10);
        const endHour = parseInt(schedule[0].end_time.split(':')[0], 10);

        const [booked] = await db.query(
            `SELECT TIME_FORMAT(start_time, '%H:%i') AS slot
       FROM bookings
       WHERE trainer_id = ? AND DATE(start_time) = ? AND status = 'scheduled'`,
            [trainer_id, date]
        );
        const bookedSet = new Set(booked.map(b => b.slot));

        const now = new Date();
        const todayStr = now.toLocaleDateString('en-CA');
        const currentHour = now.getHours();

        const availableSlots = [];
        for (let h = startHour; h < endHour; h++) {
            if (date === todayStr && h <= currentHour) continue;

            const slot = `${String(h).padStart(2, '0')}:00`;
            if (!bookedSet.has(slot)) {
                availableSlots.push(slot);
            }
        }

        res.json(availableSlots);
    } catch (error) {
        console.error('Помилка отримання вільних слотів:', error);
        res.status(500).json([]);
    }
};

exports.addBooking = async (req, res, db) => {
    const clientId = req.session.user.id;
    const { trainer_id, price_id, start_date, start_time, payment_option } = req.body;

    const [schedule] = await db.query(
        "SELECT start_time, end_time FROM trainer_schedules WHERE trainer_id = ? AND work_date = ?",
        [trainer_id, start_date]
    );
    if (schedule.length === 0) {
        return res.send(`<script>alert('Обраний тренер не працює в цей день!'); window.location.href='/client/dashboard';</script>`);
    }
    const reqHour = parseInt(start_time.split(':')[0], 10);
    const startHour = parseInt(schedule[0].start_time.split(':')[0], 10);
    const endHour = parseInt(schedule[0].end_time.split(':')[0], 10);
    if (reqHour < startHour || reqHour >= endHour) {
        return res.send(`<script>alert('Обраний час виходить за межі робочої зміни тренера!'); window.location.href='/client/dashboard';</script>`);
    }

    const fullDateTime = `${start_date} ${start_time}:00`;
    const connection = await db.getConnection();

    try {
        await connection.beginTransaction();

        const [existing] = await connection.query(
            "SELECT id FROM bookings WHERE trainer_id = ? AND start_time = ? AND status = 'scheduled'",
            [trainer_id, fullDateTime]
        );
        if (existing.length > 0) {
            await connection.rollback();
            return res.send(`<script>alert('Цей час вже зайнятий! Оберіть інший слот.'); window.location.href='/client/dashboard';</script>`);
        }

        const [priceRows] = await connection.query("SELECT title, cost, bas_guid FROM price_list WHERE id = ?", [price_id]);
        const [clientRows] = await connection.query("SELECT deposit_balance, bas_guid FROM clients WHERE id = ? FOR UPDATE", [clientId]);

        const service = priceRows[0];
        const client = clientRows[0];
        let paymentStatus = 'unpaid';
        let basActionType = null;

        if (payment_option === 'balance') {
            if (Number(client.deposit_balance) < Number(service.cost)) {
                await connection.rollback();
                return res.send(`<script>alert('Недостатньо коштів на балансі!'); window.location.href='/client/dashboard';</script>`);
            }
            await connection.query("UPDATE clients SET deposit_balance = deposit_balance - ? WHERE id = ?", [service.cost, clientId]);
            paymentStatus = 'paid_from_balance';
            basActionType = 'sale_only';
        } else if (payment_option === 'online') {
            paymentStatus = 'paid_online';
            basActionType = 'both';
        }

        const [insertRes] = await connection.query(
            `INSERT INTO bookings (client_id, trainer_id, price_id, start_time, end_time, status, payment_status)
             VALUES (?, ?, ?, ?, DATE_ADD(?, INTERVAL 1 HOUR), 'scheduled', ?)`,
            [clientId, trainer_id, price_id, fullDateTime, fullDateTime, paymentStatus]
        );
        const newBookingId = insertRes.insertId;

        await connection.commit();
        res.redirect('/client/dashboard');

        if (basActionType && client.bas_guid) {
            axios.post('https://operation-profound-anew.ngrok-free.dev/base/hs/sync/sale', {
                action_type: basActionType,
                client_guid: client.bas_guid,
                service_guid: service.bas_guid,
                service_title: service.title,
                sum: service.cost,
                payment_method: basActionType === 'both' ? 'card' : 'balance'
            }, {
                auth: { username: 'Адміністратор', password: '' }
            })
                .then(async (basResponse) => {
                    if (basResponse.data && basResponse.data.bas_doc_guid) {
                        await db.query("UPDATE bookings SET bas_doc_guid = ? WHERE id = ?", [basResponse.data.bas_doc_guid, newBookingId]);
                    }
                })
                .catch(err => console.error('[BAS] Помилка вивантаження тренування:', err.response?.data || err.message));
        }
    } catch (e) {
        await connection.rollback();
        console.error(e);
        res.send("Помилка при створенні запису");
    } finally {
        connection.release();
    }
};

exports.updateBooking = async (req, res, db) => {
    try {
        const clientId = req.session.user.id;
        const { booking_id, trainer_id, new_date, new_time } = req.body;

        const [schedule] = await db.query(
            "SELECT start_time, end_time FROM trainer_schedules WHERE trainer_id = ? AND work_date = ?",
            [trainer_id, new_date]
        );
        if (schedule.length === 0) {
            return res.send(`<script>alert('Обраний тренер не працює в цей день!'); window.location.href='/client/dashboard';</script>`);
        }
        const reqHour = parseInt(new_time.split(':')[0], 10);
        const startHour = parseInt(schedule[0].start_time.split(':')[0], 10);
        const endHour = parseInt(schedule[0].end_time.split(':')[0], 10);
        if (reqHour < startHour || reqHour >= endHour) {
            return res.send(`<script>alert('Обраний час виходить за межі робочої зміни тренера!'); window.location.href='/client/dashboard';</script>`);
        }
        const fullDateTime = `${new_date} ${new_time}:00`;

        const [existing] = await db.query(
            "SELECT id FROM bookings WHERE trainer_id = ? AND start_time = ? AND status = 'scheduled' AND id != ?",
            [trainer_id, fullDateTime, booking_id]
        );
        if (existing.length > 0) {
            return res.send(`<script>alert('Цей час вже зайнятий!'); window.location.href='/client/dashboard';</script>`);
        }

        await db.query(
            "UPDATE bookings SET start_time = ?, end_time = DATE_ADD(?, INTERVAL 1 HOUR) WHERE id = ? AND client_id = ? AND status = 'scheduled'",
            [fullDateTime, fullDateTime, booking_id, clientId]
        );
        res.redirect('/client/dashboard');
    } catch (e) {
        console.error(e);
        res.send("Помилка перенесення запису");
    }
};

exports.cancelBooking = async (req, res, db) => {
    const clientId = req.session.user.id;
    const { booking_id } = req.body;
    const connection = await db.getConnection();

    try {
        await connection.beginTransaction();

        const [rows] = await connection.query(`
            SELECT b.start_time, b.status, b.payment_status, p.cost
            FROM bookings b
            JOIN price_list p ON b.price_id = p.id
            WHERE b.id = ? AND b.client_id = ? FOR UPDATE
        `, [booking_id, clientId]);

        if (rows.length > 0 && rows[0].status === 'scheduled') {
            const booking = rows[0];
            await connection.query("UPDATE bookings SET status = 'cancelled_by_client' WHERE id = ?", [booking_id]);

            const hoursUntilStart = (new Date(booking.start_time) - new Date()) / (1000 * 60 * 60);
            if (booking.payment_status !== 'unpaid' && hoursUntilStart >= CANCEL_FREE_HOURS) {
                await connection.query(
                    "UPDATE clients SET deposit_balance = deposit_balance + ? WHERE id = ?",
                    [booking.cost, clientId]
                );
            }
        }

        await connection.commit();
        res.redirect('/client/dashboard');
    } catch (e) {
        await connection.rollback();
        console.error(e);
        res.send("Помилка скасування запису");
    } finally {
        connection.release();
    }
};

exports.getProfile = async (req, res, db) => {
    try {
        const clientId = req.session.user.id;
        const [clientData] = await db.query("SELECT full_name, email, barcode, deposit_balance FROM clients WHERE id = ?", [clientId]);
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

        const [anySub] = await db.query("SELECT id FROM subscriptions WHERE client_id = ? LIMIT 1", [clientId]);
        const hasPurchase = anySub.length > 0;

        const [singleVisit] = await db.query(`
               SELECT p.cost FROM subscriptions s
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
           `, [clientId]);

        const discount = singleVisit.length > 0 ? Number(singleVisit[0].cost) : 0;

        const [prices] = await db.query(
            "SELECT * FROM price_list WHERE title LIKE '%абонемент%' OR title LIKE '%разов%' OR title LIKE '%день%' OR duration LIKE '%місяць%' OR duration LIKE '%рік%' OR duration LIKE '%день%' ORDER BY cost ASC"
        );

        res.render('client_profile', {
            user: req.session.user,
            clientInfo: client,
            subscription: subscription,
            hasPurchase: hasPurchase,
            discount: discount,
            pricesJson: JSON.stringify(prices)
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

exports.buySubscription = async (req, res, db) => {
    try {
        const client_id = req.session.user.id;
        const { price_id, payment_method } = req.body;

        const [priceData] = await db.query("SELECT title, duration, cost, bas_guid FROM price_list WHERE id = ?", [price_id]);
        const durationStr = (priceData[0].duration || '').toLowerCase();
        const titleStr = (priceData[0].title || '').toLowerCase();
        const service_guid = priceData[0].bas_guid;

        let finalCost = priceData[0].cost;
        const purchaseDate = new Date();

        const isTryingToBuySingle = durationStr.includes('день') || titleStr.includes('разов');

        if (isTryingToBuySingle) {
            return res.send(`<script>alert('Разове відвідування можна придбати лише на касі у менеджера!'); window.history.back();</script>`);
        } else {
            const [singleVisit] = await db.query(`
                SELECT p.cost FROM subscriptions s
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
            "INSERT INTO subscriptions (client_id, price_id, purchase_date, activation_date, end_date, source, payment_method) VALUES (?, ?, ?, ?, ?, 'online', ?)",
            [client_id, price_id, purchaseDate, activationDate, endDate, payment_method]
        );
        const newSubId = subResult.insertId;

        const [clientData] = await db.query("SELECT bas_guid FROM clients WHERE id = ?", [client_id]);
        const bas_guid = clientData.length > 0 ? clientData[0].bas_guid : null;

        res.redirect('/client/profile');

        if (bas_guid) {
            axios.post('https://operation-profound-anew.ngrok-free.dev/base/hs/sync/sale', {
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
                    }
                })
                .catch(basError => console.error('[BAS] Помилка вивантаження онлайн-продажу:', basError.message));
        }

    } catch (e) {
        console.error(e);
        res.send("Помилка при купівлі абонемента");
    }
};