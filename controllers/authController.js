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

        req.session.user = {
            id: user.id,
            login: user.login,
            role: user.role
        };

        console.log(`Користувач ${user.login} увійшов як ${user.role}`);

        if (user.role === 'manager') {
            res.redirect('/manager/dashboard');
        } else if (user.role === 'client') {
            res.redirect('/client/dashboard');
        } else if (user.role === 'trainer') {
            res.redirect('/trainer/dashboard');
        } else {
            res.redirect('/');
        }

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