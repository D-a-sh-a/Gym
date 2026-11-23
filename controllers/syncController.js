const db = require('../database/db');
const bcrypt = require('bcrypt');

const formatPhone = (phone) => {
    if (!phone) return '';
    return phone.replace(/[^\d+]/g, '');
};

exports.syncTrainersFromBAS = async (req, res) => {
    const { secret_key, trainers } = req.body;

    if (secret_key !== 'BAS_SYNC_KEY_123') {
        return res.status(403).json({ error: 'Доступ заборонено' });
    }

    if (!trainers || !Array.isArray(trainers)) {
        return res.status(400).json({ error: 'Не передано масив тренерів' });
    }

    try {
        for (const trainer of trainers) {
            const [existing] = await db.query(
                "SELECT id FROM trainers WHERE bas_guid = ?",
                [trainer.bas_guid]
            );

            const userLogin = trainer.email || `trainer_${trainer.bas_guid.substring(0, 8)}`;
            const cleanPhone = formatPhone(trainer.phone);
            const photoBuffer = trainer.photo ? Buffer.from(trainer.photo, 'base64') : null;

            const isActive = trainer.is_active !== undefined ? (trainer.is_active ? 1 : 0) : 1;

            if (existing.length > 0) {
                const trainerId = existing[0].id;

                await db.query(`
                    UPDATE trainers 
                    SET full_name = ?, phone = ?, email = ?, photo = ?, is_active = ? 
                    WHERE id = ?
                `, [trainer.full_name, cleanPhone, trainer.email || '', photoBuffer, isActive, trainerId]);

                await db.query(`
                    UPDATE users 
                    SET login = ?, is_active = ? 
                    WHERE id = ?
                `, [userLogin, isActive, trainerId]);

            } else {
                if (isActive === 0) continue;

                const defaultPasswordHash = '$2b$10$zPy4pCmf4IFpQ4ipap.2yexfwjNWuPvDT8P7.QfjcH3K6uqV/IUZS';

                const [userResult] = await db.query(`
                    INSERT INTO users (login, role, password, is_active) 
                    VALUES (?, 'trainer', ?, ?)
                `, [userLogin, defaultPasswordHash, isActive]);

                const newId = userResult.insertId;

                await db.query(`
                    INSERT INTO trainers (id, bas_guid, full_name, phone, email, description, experience, photo, is_active)
                    VALUES (?, ?, ?, ?, ?, '', 0, ?, ?)
                `, [newId, trainer.bas_guid, trainer.full_name, cleanPhone, trainer.email || '', photoBuffer, isActive]);
            }
        }

        res.status(200).json({ success: true, message: 'Кадрові дані та фото синхронізовано' });
    } catch (error) {
        console.error('Помилка синхронізації тренерів з BAS:', error);
        res.status(500).json({ error: 'Помилка бази даних' });
    }
};

exports.syncPriceFromBAS = async (req, res) => {
    const { secret_key, services } = req.body;

    if (secret_key !== 'BAS_SYNC_KEY_123') {
        return res.status(403).json({ error: 'Доступ заборонено' });
    }

    if (!services || !Array.isArray(services)) {
        return res.status(400).json({ error: 'Не передано масив послуг' });
    }

    try {
        for (const service of services) {
            const [existing] = await db.query("SELECT id FROM price_list WHERE bas_guid = ?", [service.bas_guid]);

            if (existing.length > 0) {
                await db.query(`
                    UPDATE price_list SET title = ?, cost = ?, duration = ? WHERE id = ?
                `, [service.title, service.cost, service.duration, existing[0].id]);
            } else {
                await db.query(`
                    INSERT INTO price_list (bas_guid, title, cost, duration)
                    VALUES (?, ?, ?, ?)
                `, [service.bas_guid, service.title, service.cost, service.duration]);
            }
        }

        res.status(200).json({ success: true, message: 'Прайс-лист синхронізовано' });
    } catch (error) {
        console.error('Помилка синхронізації прайс-листа з BAS:', error);
        res.status(500).json({ error: 'Помилка бази даних' });
    }
};

exports.syncSchedulesFromBAS = async (req, res) => {
    const { secret_key, schedules } = req.body;

    if (secret_key !== 'BAS_SYNC_KEY_123') {
        return res.status(403).json({ error: 'Доступ заборонено' });
    }

    if (!schedules || !Array.isArray(schedules)) {
        return res.status(400).json({ error: 'Не передано масив графіків' });
    }

    const connection = await db.getConnection();
    try {
        const [trainers] = await connection.query(
            "SELECT id, bas_guid FROM trainers WHERE is_active = 1 AND bas_guid IS NOT NULL"
        );
        const guidToId = {};
        trainers.forEach(t => { guidToId[t.bas_guid] = t.id; });

        await connection.beginTransaction();

        await connection.query("DELETE FROM trainer_schedules WHERE work_date >= CURDATE()");

        let totalInserted = 0;

        for (const item of schedules) {
            const trainerId = guidToId[item.trainer_guid];
            if (!trainerId || !Array.isArray(item.work_dates)) continue;

            for (const dateStr of item.work_dates) {
                const day = new Date(`${dateStr}T12:00:00`).getDay();
                const startTime = day === 0 ? '10:00:00' : '09:00:00';
                const endTime = '18:00:00';

                await connection.query(
                    `INSERT INTO trainer_schedules (trainer_id, work_date, start_time, end_time)
                     VALUES (?, ?, ?, ?)
                     ON DUPLICATE KEY UPDATE start_time = VALUES(start_time), end_time = VALUES(end_time)`,
                    [trainerId, dateStr, startTime, endTime]
                );
                totalInserted++;
            }
        }

        await connection.commit();
        res.status(200).json({
            success: true,
            message: `Графіки синхронізовано. Оновлено робочих днів: ${totalInserted}`
        });
    } catch (error) {
        await connection.rollback();
        console.error('Помилка синхронізації графіків з BAS:', error);
        res.status(500).json({ error: 'Помилка бази даних' });
    } finally {
        connection.release();
    }
};

exports.syncManagers = async (req, res) => {
  try {
    const { secret_key, managers } = req.body;
    if (secret_key !== 'BAS_SYNC_KEY_123') {
      return res.status(403).json({ error: 'Невірний ключ доступу' });
    }

    if (!Array.isArray(managers)) {
      return res.status(400).json({ error: 'Очікується масив managers' });
    }

    const defaultPasswordHash = await bcrypt.hash('123456', 10);
    const activeGuids = [];

    for (const m of managers) {
      if (!m.guid) continue;
      activeGuids.push(m.guid);

      const email = m.email || `manager_${m.guid.slice(0, 8)}@gym.local`;
      const phone = m.phone || '';

      const [existing] = await db.query(
        "SELECT id FROM managers WHERE bas_guid = ? OR email = ? LIMIT 1",
        [m.guid, email]
      );

      if (existing.length > 0) {
        const userId = existing[0].id;

        await db.query(
          "UPDATE users SET login = ?, is_active = 1 WHERE id = ?",
          [email, userId]
        );
        await db.query(
          "UPDATE managers SET full_name = ?, phone = ?, email = ?, bas_guid = ?, is_active = 1 WHERE id = ?",
          [m.full_name, phone, email, m.guid, userId]
        );
      } else {
        const [uRes] = await db.query(
          "INSERT INTO users (login, password, role, is_active) VALUES (?, ?, 'manager', 1)",
          [email, defaultPasswordHash]
        );
        const newUserId = uRes.insertId;

        await db.query(
          "INSERT INTO managers (id, full_name, phone, email, bas_guid, is_active) VALUES (?, ?, ?, ?, ?, 1)",
          [newUserId, m.full_name, phone, email, m.guid]
        );
      }
    }

    if (activeGuids.length > 0) {
      await db.query(
        "UPDATE managers SET is_active = 0 WHERE bas_guid IS NOT NULL AND bas_guid NOT IN (?)",
        [activeGuids]
      );
      await db.query(
        `UPDATE users u
         JOIN managers m ON u.id = m.id
         SET u.is_active = 0
         WHERE m.bas_guid IS NOT NULL AND m.bas_guid NOT IN (?)`,
        [activeGuids]
      );
    }

    res.json({ success: true, count: managers.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};