#include "drogon_ctrl.h"
using namespace api::v1;
void User::getInfo(const HttpRequestPtr &req, std::function<void(const HttpResponsePtr &)> &&callback, int id) const {
  callback(HttpResponse::newHttpResponse());
}
void User::create(const HttpRequestPtr &req, std::function<void(const HttpResponsePtr &)> &&callback) {}
void User::list(const HttpRequestPtr &req, std::function<void(const HttpResponsePtr &)> &&callback) {}
void Ping::asyncHandleHttpRequest(const HttpRequestPtr &req, std::function<void(const HttpResponsePtr &)> &&callback) {}
void setup() {
  drogon::app().registerHandler("/hello", [](const HttpRequestPtr &req, std::function<void(const HttpResponsePtr &)> &&callback) {
    callback(HttpResponse::newHttpResponse());
  }, {Get, Post});
}
