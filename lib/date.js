function getParts(date, options) {
  const formatter = new Intl.DateTimeFormat("en-CA", options);
  const parts = formatter.formatToParts(date);
  return Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
}

export function getJstDateString(date = new Date()) {
  const values = getParts(date, {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  return `${values.year}${values.month}${values.day}`;
}

export function getJstTimestamp(date = new Date()) {
  const values = getParts(date, {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });
  return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}:${values.second}+09:00`;
}
