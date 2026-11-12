#include "crow.h"

static const char *kApiPrefix = "api";

static crow::response health(const crow::request &) { return crow::response(200); }

int main() {
  crow::SimpleApp app;
  crow::Blueprint bp("api");
  crow::Blueprint users("users");

  CROW_ROUTE(app, "/")([]() { return "Hello"; });
  CROW_ROUTE(app, "/health")(health);
  CROW_ROUTE(app, "/items/<int>").methods(crow::HTTPMethod::Post, "PUT"_method)([](const crow::request &req, int id) {
    return crow::response(204);
  });
  CROW_BP_ROUTE(bp, "/status")([]() { return "ok"; });
  CROW_BP_ROUTE(users, "/<string>").methods("GET"_method)([](std::string name) { return name; });
  bp.register_blueprint(users);
  app.register_blueprint(bp);
  app.port(18080).multithreaded().run();
}
