#include <gtest/gtest.h>
#include "../src/calc.h"

class CalcFixture : public ::testing::Test {};

TEST(CalcSuite, Adds) { EXPECT_EQ(add(1, 2), 3); }
TEST_F(CalcFixture, Doubles) { EXPECT_EQ(twice(2), 4); }
TEST_P(CalcParam, Many) { EXPECT_GT(twice(GetParam()), 0); }
