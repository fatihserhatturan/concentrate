#include <httplib.h>
#include <pistache/router.h>
using namespace Pistache;

void getUser(const httplib::Request &req, httplib::Response &res) { res.set_content("u", "text/plain"); }

class Endpoint {
 public:
  void setup() {
    Rest::Routes::Get(router, "/records/:id", Rest::Routes::bind(&Endpoint::readRecord, this));
    Rest::Routes::Post(router, "/records", Rest::Routes::bind(&Endpoint::addRecord, this));
  }
  void readRecord(const Rest::Request &, Http::ResponseWriter) {}
  void addRecord(const Rest::Request &, Http::ResponseWriter) {}
  Rest::Router router;
};

int main() {
  httplib::Server svr;
  svr.Get("/hi", [](const httplib::Request &, httplib::Response &res) { res.set_content("Hello World!", "text/plain"); });
  svr.Get(R"(/numbers/(\d+))", [&](const httplib::Request &req, httplib::Response &res) { res.set_content(req.matches[1], "text/plain"); });
  svr.Post("/users", getUser);
  svr.Delete("/users/:id", std::bind(&getUser, std::placeholders::_1, std::placeholders::_2));
  svr.listen("0.0.0.0", 8080);
}
