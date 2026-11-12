file(GLOB NET_SOURCES CONFIGURE_DEPENDS src/*.cpp)
add_library(net SHARED ${NET_SOURCES})
target_include_directories(net PUBLIC $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include> $<INSTALL_INTERFACE:include>)
# core's PUBLIC include directory reaches net, and everything that links net.
target_link_libraries(net PUBLIC core)
