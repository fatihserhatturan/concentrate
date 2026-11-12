#include <curl/curl.h>
#include <cpr/cpr.h>
#include <httplib.h>
#include <cstdlib>
#include <string>

static const std::string kBase = "http://localhost:8080";

void listUsers() {
  CURL *curl = curl_easy_init();
  curl_easy_setopt(curl, CURLOPT_URL, "http://localhost:8080/api/users");
  curl_easy_perform(curl);
  curl_easy_cleanup(curl);
}

void createUser(const std::string &name) {
  CURL *curl = curl_easy_init();
  std::string url = kBase + "/api/users";
  curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
  curl_easy_setopt(curl, CURLOPT_POSTFIELDS, name.c_str());
  CURLcode rc = curl_easy_perform(curl);
}

void deleteUser(int id) {
  CURL *curl = curl_easy_init();
  curl_easy_setopt(curl, CURLOPT_URL, (kBase + "/api/users/" + std::to_string(id)).c_str());
  curl_easy_setopt(curl, CURLOPT_CUSTOMREQUEST, "DELETE");
  curl_easy_perform(curl);
}

void viaCpr() {
  cpr::Response r = cpr::Get(cpr::Url{"http://localhost:8080/api/users"});
  auto p = cpr::Post(cpr::Url{kBase + "/api/users"}, cpr::Body{"{}"});
  cpr::Session session;
  session.SetUrl(cpr::Url{"http://localhost:8080/api/users/7"});
  session.Put();
}

void viaHttplib() {
  httplib::Client cli("localhost", 8080);
  auto res = cli.Get("/api/users");
  auto token = std::getenv("API_TOKEN");
}
