#include <httplib.h>
int main() {
  httplib::Server svr;
  svr.Get("/api/users", [](const httplib::Request &, httplib::Response &res) {});
  svr.Post("/api/users", [](const httplib::Request &, httplib::Response &res) {});
  svr.Put("/api/users/:id", [](const httplib::Request &, httplib::Response &res) {});
  svr.Delete("/api/users/:id", [](const httplib::Request &, httplib::Response &res) {});
  svr.listen("0.0.0.0", 8080);
}
