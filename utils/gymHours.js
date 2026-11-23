exports.isWithinGymHours = (dateStr, timeStr) => {
  const day = new Date(`${dateStr}T12:00:00`).getDay();
  const hour = parseInt(timeStr.split(':')[0], 10);

  if (day === 0) return hour >= 10 && hour <= 17;
  if (day === 6) return hour >= 9 && hour <= 20;
  return hour >= 8 && hour <= 21;
};