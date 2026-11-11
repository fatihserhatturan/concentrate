#pragma once

#define GEO_API __attribute__((visibility("default")))

namespace geo {

class GEO_API Widget {
public:
  Widget();
  int size() const;
};

}  // namespace geo
