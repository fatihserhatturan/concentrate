#include <curl/curl.h>
#include <libpq-fe.h>
#include <sqlite3.h>
#include <stdlib.h>

#define PG_URL_ENV "DATABASE_URL"

static int forward(const char *payload) {
  CURL *curl = curl_easy_init();
  if (!curl) return 1;
  curl_easy_setopt(curl, CURLOPT_URL, "http://localhost:9000/ingest");
  curl_easy_setopt(curl, CURLOPT_POSTFIELDS, payload);
  CURLcode code = curl_easy_perform(curl);
  curl_easy_cleanup(curl);
  return code;
}

static int save(sqlite3 *db) {
  return sqlite3_exec(db, "INSERT INTO samples (value) VALUES (1)", NULL, NULL, NULL);
}

static void purge(PGconn *conn) {
  PQexec(conn, "DELETE FROM samples WHERE value < 0");
}

int main(void) {
  const char *url = getenv(PG_URL_ENV);
  const char *token = secure_getenv("INGEST_TOKEN");
  sqlite3 *db = NULL;
  if (url == NULL || token == NULL) return 1;
  save(db);
  return forward("{}");
}
