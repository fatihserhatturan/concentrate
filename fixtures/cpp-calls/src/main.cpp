#include <memory>
#include <vector>
#include "geo/shape.h"
#include "geo/util.h"

using namespace geo;
using geo::util::clamp_count;

struct Registry {
  std::vector<std::unique_ptr<Shape>> shapes;
  Circle favourite{1.0};

  void add(std::unique_ptr<Shape> shape) { shapes.push_back(std::move(shape)); }
  double sum() const {
    double total = 0;
    for (const auto& shape : shapes) total += shape->area();
    return total + favourite.area();
  }
};

static void print_all(Shape* shape) {
  shape->describe();
  shape->area();
}

int main(int argc, char** argv) {
  Registry registry;
  auto circle = std::make_unique<Circle>(2.0);
  Square square(3.0);
  Shape& ref = square;
  Circle* raw = new Circle(1.5);
  registry.add(std::move(circle));
  print_all(raw);
  print_all(&square);
  ref.area();
  raw->name();
  total_area(square, *raw);
  geo::total_area(square, square);
  util::log_line("start");
  clamp_count(argc);
  int limited = CLAMP(argc, 0, 4);
  registry.sum();
  return limited;
}
