set(CORE_SOURCES
  src/core.cpp
  src/clock.cpp
)
add_library(core STATIC ${CORE_SOURCES} include/core/core.h)
target_include_directories(core
  PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/include
  PRIVATE src
)
target_compile_definitions(core PUBLIC CORE_ENABLED=1)
