#include <catch2/catch_test_macros.hpp>
#include "../src/calc.h"

TEST_CASE("calc adds", "[calc]") {
  SECTION("positive numbers") { REQUIRE(add(2, 2) == 4); }
  SECTION("zero") { REQUIRE(add(0, 0) == 0); }
}

SCENARIO("doubling") {
  GIVEN("a number") { WHEN("doubled") { THEN("it grows") { REQUIRE(twice(3) == 6); } } }
}
