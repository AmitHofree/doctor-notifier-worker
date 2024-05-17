CREATE TABLE IF NOT EXISTS notification_date (
	item_key_index VARCHAR(100) PRIMARY KEY,
	last_notification_date DATE
);

CREATE TABLE IF NOT EXISTS notifications_registered (
    chat_id NUMBER,
    item_key_index VARCHAR(100),
    PRIMARY KEY (chat_id, item_key_index)
);