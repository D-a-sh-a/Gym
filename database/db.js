const mysql = require('mysql2');

const pool = mysql.createPool({
  connectionLimit: 5,
  host: "localhost",
  user: "root",
  database: "gym",
  password: ""
});

module.exports = pool.promise();