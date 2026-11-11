add_executable(demo main.cpp)
target_link_libraries(demo PRIVATE net ${DEMO_EXTRA_LIBS} Threads::Threads)
target_compile_definitions(demo PRIVATE APP_CONFIG_HEADER="app/config.h")
