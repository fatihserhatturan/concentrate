cmake_minimum_required(VERSION 3.16)
project(Demo VERSION 1.0 LANGUAGES CXX)

option(BUILD_TOOLS "Build the command line tools" ON)

# Directory-level include path: every target of this directory and of the
# subdirectories added below sees config/.
include_directories(${CMAKE_SOURCE_DIR}/config)
add_definitions(-DDEMO_VERSION=1)

add_subdirectory(libs/core)
add_subdirectory(libs/net)
add_subdirectory(app)
if(BUILD_TOOLS)
  add_subdirectory(tools)
endif()
