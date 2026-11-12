#pragma once
#include <drogon/HttpController.h>
using namespace drogon;
namespace api {
namespace v1 {
class User : public drogon::HttpController<User> {
 public:
  METHOD_LIST_BEGIN
  METHOD_ADD(User::getInfo, "/{1}/info", Get, "LoginFilter");
  METHOD_ADD(User::create, "", Post);
  ADD_METHOD_TO(User::list, "/users", Get, Post);
  METHOD_LIST_END
  void getInfo(const HttpRequestPtr &req, std::function<void(const HttpResponsePtr &)> &&callback, int id) const;
  void create(const HttpRequestPtr &req, std::function<void(const HttpResponsePtr &)> &&callback);
  void list(const HttpRequestPtr &req, std::function<void(const HttpResponsePtr &)> &&callback);
};
}  // namespace v1
}  // namespace api
class Ping : public drogon::HttpSimpleController<Ping> {
 public:
  void asyncHandleHttpRequest(const HttpRequestPtr &req, std::function<void(const HttpResponsePtr &)> &&callback) override;
  PATH_LIST_BEGIN
  PATH_ADD("/ping", Get, Post);
  PATH_LIST_END
};
