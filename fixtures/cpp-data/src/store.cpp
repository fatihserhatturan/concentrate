#include <sqlite3.h>
#include <libpq-fe.h>
#include <soci/soci.h>
#include <cstdlib>
#include <string>

#define DB_PATH_ENV "APP_DB_PATH"
static const char *kSchema = "CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE);";

int openDatabase(sqlite3 **db) {
  const char *path = std::getenv(DB_PATH_ENV);
  const char *mode = getenv("APP_DB_MODE");
  if (sqlite3_open(path ? path : ":memory:", db) != SQLITE_OK) return 1;
  return sqlite3_exec(*db, kSchema, nullptr, nullptr, nullptr);
}

int addUser(sqlite3 *db, const std::string &name) {
  sqlite3_stmt *stmt = nullptr;
  sqlite3_prepare_v2(db, "INSERT INTO users (name, email) VALUES (?, ?)", -1, &stmt, nullptr);
  sqlite3_step(stmt);
  return sqlite3_finalize(stmt);
}

int listUsers(sqlite3 *db) {
  std::string sql = "SELECT u.id, u.name FROM users u JOIN orders o ON o.user_id = u.id";
  return sqlite3_exec(db, sql.c_str(), nullptr, nullptr, nullptr);
}

void removeOrders(PGconn *conn, int userId) {
  PGresult *res = PQexecParams(conn, "DELETE FROM orders WHERE user_id = $1", 1, nullptr, nullptr, nullptr, nullptr, 0);
  PQclear(res);
  PQexec(conn, "UPDATE accounts SET balance = 0");
}

void touch(soci::session &sql, int id) {
  sql << "UPDATE users SET name = :n WHERE id = :id", soci::use(id);
  sql.once << "SELECT count(*) FROM events";
}

int main() {
  sqlite3 *db = nullptr;
  openDatabase(&db);
  addUser(db, "ada");
  return 0;
}
