#include <httplib.h>
#include <sqlite3.h>
#include <cstdlib>

int main() {
  httplib::Server svr;
  sqlite3 *db = nullptr;
  const char *port = secure_getenv("APP_PORT");
  svr.Get("/api/users", [&](const httplib::Request &, httplib::Response &res) {
    sqlite3_exec(db, "SELECT id, name FROM users", nullptr, nullptr, nullptr);
    res.set_content("[]", "application/json");
  });
  svr.Post("/api/users", [&](const httplib::Request &req, httplib::Response &res) {
    sqlite3_exec(db, "INSERT INTO users (name) VALUES ('x')", nullptr, nullptr, nullptr);
  });
  svr.listen("0.0.0.0", port ? atoi(port) : 8080);
}
