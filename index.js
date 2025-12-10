const mysql = require('mysql2');
const express = require('express');
const path = require('path');
const bodyParser = require('body-parser');
const hbs = require('hbs');
const app = express();
hbs.registerPartials(path.join(__dirname, 'views/partials'));
const db = require('./database/db');
const session = require('express-session');
const authController = require('./controllers/authController');
const trainerController = require('./controllers/trainerController');
const clientController = require('./controllers/clientController');
const managerController = require('./controllers/managerController');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });

hbs.registerHelper('isManager', (user) => user && user.role === 'manager');
hbs.registerHelper('isTrainer', (user) => user && user.role === 'trainer');
hbs.registerHelper('isClient', (user) => user && user.role === 'client');

app.use(session({
    secret: 'secret_gym_key',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 3600000 }
}));

app.use(function(req, res, next) {
    res.locals.user = req.session.user;
    next();
});

app.set('view engine', 'hbs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.static(path.join(__dirname, 'public')));

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

app.get('/', (req, res) => {
    res.render('index', { title: 'GYM - Головна', user: req.session.user });
});

//неавторизовані
app.get('/login', (req, res) => {
    res.render('login');
});

app.post('/auth/login', authController.login);
app.get('/auth/logout', authController.logout);

app.get('/trainers', async (req, res) => {
    try {
        const [trainers] = await db.query('SELECT * FROM trainers');
        res.render('trainers', { 
            title: 'Наші Тренери', 
            trainersList: trainers,
            user: req.session.user
        });
    } catch (error) {
        console.error(error);
        res.send("Помилка при завантаженні тренерів");
    }
});

app.get('/trainer/image/:id', async (req, res) => {
    try {
        const [rows] = await db.query('SELECT photo FROM trainers WHERE id = ?', [req.params.id]);
        if (rows.length > 0 && rows[0].photo) {
            res.end(rows[0].photo); 
        } else {
            res.status(404).send('Not found');
        }
    } catch (error) {
        console.error(error);
        res.status(500).send('Error');
    }
});

app.get('/price', async (req, res) => {
    try {
        const [prices] = await db.query('SELECT * FROM price_list');
        res.render('price', { 
            title: 'Прайс-лист', 
            priceList: prices,
            user: req.session.user 
        });
    } catch (error) {
        console.error(error);
        res.send("Помилка при завантаженні цін");
    }
});

//тренери
app.get('/trainer/dashboard', (req, res) => {
    if (!req.session.user || req.session.user.role !== 'trainer') {
        return res.redirect('/login');
    }
    trainerController.getDashboard(req, res, db);
});
app.post('/trainer/add-booking', (req, res) => {
    if (!req.session.user || req.session.user.role !== 'trainer') return res.redirect('/login');
    trainerController.addBooking(req, res, db);
});
app.post('/trainer/delete-booking', (req, res) => {
    if (!req.session.user || req.session.user.role !== 'trainer') return res.redirect('/login');
    trainerController.deleteBooking(req, res, db);
});
app.post('/trainer/edit-booking', (req, res) => {
    if (!req.session.user || req.session.user.role !== 'trainer') return res.redirect('/login');
    trainerController.updateBooking(req, res, db);
});

//клієнти
app.get('/client/dashboard', (req, res) => {
    if (!req.session.user || req.session.user.role !== 'client') return res.redirect('/login');
    clientController.getDashboard(req, res, db);
});
app.get('/client/profile', (req, res) => {
    if (!req.session.user || req.session.user.role !== 'client') return res.redirect('/login');
    clientController.getProfile(req, res, db);
});
app.post('/client/change-password', (req, res) => {
    if (!req.session.user || req.session.user.role !== 'client') return res.redirect('/login');
    clientController.changePassword(req, res, db);
});

//менеджери
app.get('/manager/dashboard', (req, res) => {
    if (!req.session.user || req.session.user.role !== 'manager') return res.redirect('/login');
    managerController.getDashboard(req, res);
});
app.get('/manager/clients', (req, res) => {
    if (!req.session.user || req.session.user.role !== 'manager') return res.redirect('/login');
    managerController.getClientsPage(req, res);
});
app.post('/manager/add-booking', (req, res) => {
    if (!req.session.user || req.session.user.role !== 'manager') return res.redirect('/login');
    managerController.addBooking(req, res);
});
app.post('/manager/delete-booking', (req, res) => {
    if (!req.session.user || req.session.user.role !== 'manager') return res.redirect('/login');
    managerController.deleteBooking(req, res);
});
app.post('/manager/edit-booking', (req, res) => {
    if (!req.session.user || req.session.user.role !== 'manager') return res.redirect('/login');
    managerController.updateBooking(req, res);
});
app.post('/manager/register', (req, res) => {
    if (!req.session.user || req.session.user.role !== 'manager') return res.redirect('/login');
    managerController.registerClient(req, res);
});
app.post('/manager/sell', (req, res) => {
    if (!req.session.user || req.session.user.role !== 'manager') return res.redirect('/login');
    managerController.sellSubscription(req, res);
});
app.post('/manager/reset-password', (req, res) => {
    if (!req.session.user || req.session.user.role !== 'manager') return res.redirect('/login');
    managerController.resetPassword(req, res);
});
app.post('/manager/edit-client', (req, res) => {
    if (!req.session.user || req.session.user.role !== 'manager') return res.redirect('/login');
    managerController.updateClient(req, res);
});
app.get('/manager/trainers', (req, res) => {
    if (!req.session.user || req.session.user.role !== 'manager') return res.redirect('/login');
    managerController.getTrainersPage(req, res);
});

app.post('/manager/trainers/add', upload.single('photo'), (req, res) => {
    if (!req.session.user || req.session.user.role !== 'manager') return res.redirect('/login');
    managerController.createTrainer(req, res);
});

app.post('/manager/trainers/edit', upload.single('photo'), (req, res) => {
    if (!req.session.user || req.session.user.role !== 'manager') return res.redirect('/login');
    managerController.updateTrainer(req, res);
});

app.post('/manager/trainers/delete', (req, res) => {
    if (!req.session.user || req.session.user.role !== 'manager') return res.redirect('/login');
    managerController.deleteTrainer(req, res);
});

const PORT = 3000;
app.listen(PORT, () => {
    console.log(`Сервер запущено на http://localhost:${PORT}`);
});