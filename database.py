import sqlite3
from datetime import date, datetime

DB_NAME = "users.db"

def init_db():
    """Создаёт таблицы при первом запуске"""
    with sqlite3.connect(DB_NAME) as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS users (
                user_id INTEGER PRIMARY KEY,
                username TEXT,
                premium_until DATE,
                answers_today INTEGER DEFAULT 0,
                last_answer_date TEXT
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS stats (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER,
                situation TEXT,
                chosen_answer TEXT,
                rating INTEGER,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)

def get_user(user_id: int):
    with sqlite3.connect(DB_NAME) as conn:
        conn.row_factory = sqlite3.Row
        user = conn.execute(
            "SELECT * FROM users WHERE user_id = ?", (user_id,)
        ).fetchone()
        return dict(user) if user else None

def create_user(user_id: int, username: str = None):
    with sqlite3.connect(DB_NAME) as conn:
        conn.execute(
            "INSERT OR IGNORE INTO users (user_id, username, answers_today, last_answer_date) VALUES (?, ?, 0, ?)",
            (user_id, username, date.today().isoformat())
        )

def can_get_free_answer(user_id: int) -> bool:
    user = get_user(user_id)
    if not user:
        return True
    
    # Премиум — безлимит
    if user['premium_until'] and date.today() <= date.fromisoformat(user['premium_until']):
        return True
    
    # Сброс счётчика если новый день
    today = date.today().isoformat()
    if user['last_answer_date'] != today:
        with sqlite3.connect(DB_NAME) as conn:
            conn.execute(
                "UPDATE users SET answers_today = 0, last_answer_date = ? WHERE user_id = ?",
                (today, user_id)
            )
        return True
    
    return user['answers_today'] < 5

def increment_answer_count(user_id: int):
    with sqlite3.connect(DB_NAME) as conn:
        conn.execute(
            "UPDATE users SET answers_today = answers_today + 1 WHERE user_id = ?",
            (user_id,)
        )

def save_feedback(user_id: int, situation: str, chosen_answer: str, rating: int):
    with sqlite3.connect(DB_NAME) as conn:
        conn.execute(
            "INSERT INTO stats (user_id, situation, chosen_answer, rating) VALUES (?, ?, ?, ?)",
            (user_id, situation, chosen_answer, rating)
        )
