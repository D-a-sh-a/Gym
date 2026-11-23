const db = require('../database/db');
const bcrypt = require('bcrypt');

exports.login = async (req, res) => {
    try {
        const { login, password } = req.body;
        const [users] = await db.query('SELECT * FROM users WHERE login = ?', [login]);

        if (users.length === 0) {
            return res.render('login', { message: 'Користувача з таким логіном не знайдено' });
        }

        const user = users[0];
        const isMatch = await bcrypt.compare(password, user.password);

        if (!isMatch) {
            return res.render('login', { message: 'Невірний пароль' });
        }

        let sessionData = {
            id: user.id,
            login: user.login,
            role: user.role
        };

        if (user.role === 'client') {
            const [clientRecords] = await db.query('SELECT id FROM clients WHERE email = ?', [user.login]);
            if (clientRecords.length > 0) {
                sessionData.clientId = clientRecords[0].id;
            }
        }

        req.session.user = sessionData;

        console.log(`Користувач ${user.login} увійшов як ${user.role}`);

        if (user.role === 'manager') res.redirect('/manager/dashboard');
        else if (user.role === 'client') res.redirect('/client/profile');
        else if (user.role === 'trainer') res.redirect('/trainer/dashboard');
        else res.redirect('/');

    } catch (error) {
        console.error(error);
        res.render('login', { message: 'Помилка сервера' });
    }
};

exports.logout = (req, res) => {
    req.session.destroy(() => {
        res.redirect('/');
    });
};