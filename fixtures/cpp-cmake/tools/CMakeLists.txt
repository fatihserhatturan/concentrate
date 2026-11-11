foreach(tool pack unpack)
  add_executable(${tool} ${tool}.cpp)
  target_link_libraries(${tool} PRIVATE core)
endforeach()
