#pragma once
#include <string>

namespace geo {

class Shape {
public:
  virtual ~Shape() = default;
  virtual double area() const = 0;
  virtual std::string name() const;
  void describe() const;
};

class Circle : public Shape {
public:
  explicit Circle(double radius);
  double area() const override;
  std::string name() const override;

private:
  double radius_;
};

class Square final : public Shape {
public:
  explicit Square(double side) : side_(side) {}
  double area() const override { return side_ * side_; }

private:
  double side_;
};

double total_area(const Shape& a, const Shape& b);

}  // namespace geo
