#include "geo/shape.h"
#include "geo/util.h"

namespace geo {

std::string Shape::name() const { return "shape"; }

void Shape::describe() const {
  util::log_line(name().c_str());
  util::log_line("area", 1);
}

Circle::Circle(double radius) : radius_(radius) {}

double Circle::area() const { return 3.14159 * radius_ * radius_; }

std::string Circle::name() const { return "circle"; }

double total_area(const Shape& a, const Shape& b) { return a.area() + b.area(); }

}  // namespace geo
