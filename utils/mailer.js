const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: 'dariya2004tar@gmail.com',
        pass: 'xuvw gndw sfan glqj'
    }
});

exports.sendMail = async (to, subject, htmlContent, attachments = []) => {
    try {
        await transporter.sendMail({
            from: '"GYM" <dariya2004tar@gmail.com>',
            to: to,
            subject: subject,
            html: htmlContent,
            attachments: attachments
        });
        console.log(`📧 Лист відправлено на ${to}`);
    } catch (error) {
        console.error("Помилка відправки пошти:", error);
    }
};