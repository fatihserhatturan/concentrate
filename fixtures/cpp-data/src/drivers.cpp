#include <drogon/orm/DbClient.h>
#include <mysql/mysql.h>
#include <pqxx/pqxx>
#include <sql.h>
#include <sqlext.h>

void report(pqxx::connection &c, int id) {
  pqxx::work txn{c};
  pqxx::result r{txn.exec("SELECT name FROM employee WHERE id = 1")};
  txn.exec_params("INSERT INTO employee (name) VALUES ($1)", "x");
  txn.commit();
}

void legacy(MYSQL *conn) {
  mysql_query(conn, "SELECT * FROM finance");
  mysql_query(conn, "DELETE FROM finance WHERE year < 2000");
}

void odbc(SQLHSTMT hstmt) {
  SQLExecDirect(hstmt, (SQLCHAR *)"UPDATE inventory SET stock = 0", SQL_NTS);
}

void drogonDb(const drogon::orm::DbClientPtr &client, int id) {
  client->execSqlAsync("select * from sessions where id = $1", [](const drogon::orm::Result &) {}, [](const drogon::orm::DrogonDbException &) {}, id);
}
