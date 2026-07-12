"""SQLite sidecar of raw per-game stat records for baseline generation.

One row per (replay file, port). Holding raw values (not percentiles) means
any future re-pool — by rank, by source dataset, by character — is a query,
not a multi-day rescan. The file lives at scripts/raw_stats.sqlite and is
gitignored (multi-GB, machine-local).

Record tuple accepted by insert_batch:
    (filename, port, source, player_char, opp_char, rank, rank_pair, stats_dict)
where rank is 'platinum'|'diamond'|'master'|None (None = mixed pair or
unlabeled v3.7 game) and stats_dict maps stat key -> float|None.
"""
import sqlite3


class StatsDB:
    def __init__(self, path: str, stat_keys: list[str]):
        self.stat_keys = list(stat_keys)
        self.con = sqlite3.connect(path)
        self.con.execute("PRAGMA journal_mode=WAL")
        self.con.execute("PRAGMA synchronous=NORMAL")
        stat_cols = ", ".join(f'"{k}" REAL' for k in self.stat_keys)
        self.con.execute(f"""
            CREATE TABLE IF NOT EXISTS games (
                filename    TEXT    NOT NULL,
                port        INTEGER NOT NULL,
                source      TEXT    NOT NULL,
                player_char TEXT    NOT NULL,
                opp_char    TEXT    NOT NULL,
                rank        TEXT,
                rank_pair   TEXT,
                {stat_cols},
                PRIMARY KEY (filename, port)
            ) WITHOUT ROWID
        """)
        self.con.commit()
        cols = ["filename", "port", "source", "player_char", "opp_char",
                "rank", "rank_pair"] + self.stat_keys
        placeholders = ", ".join("?" * len(cols))
        col_names = ", ".join(f'"{c}"' for c in cols)
        self._insert_sql = f"INSERT OR IGNORE INTO games ({col_names}) VALUES ({placeholders})"

    def insert_batch(self, records) -> int:
        """Insert records in one transaction. Returns number of NEW rows
        (duplicates are silently ignored via the primary key)."""
        rows = []
        for filename, port, source, player_char, opp_char, rank, rank_pair, stats in records:
            rows.append((filename, port, source, player_char, opp_char, rank, rank_pair,
                         *[stats.get(k) for k in self.stat_keys]))
        with self.con:
            before = self.con.total_changes
            self.con.executemany(self._insert_sql, rows)
            return self.con.total_changes - before

    def seen(self, filename: str) -> bool:
        """True if any port of this replay is already stored (PK prefix scan)."""
        row = self.con.execute(
            "SELECT 1 FROM games WHERE filename = ? LIMIT 1", (filename,)).fetchone()
        return row is not None

    def count(self) -> int:
        return self.con.execute("SELECT COUNT(*) FROM games").fetchone()[0]

    def close(self):
        self.con.close()
