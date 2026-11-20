package com.acme.orders.mapper;

import java.util.List;
import org.apache.ibatis.annotations.Delete;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Select;

@Mapper
public interface OrderMapper {
  @Select("SELECT id, status FROM orders WHERE customer_email = #{email}")
  List<String> byCustomer(String email);

  @Delete("DELETE FROM orders WHERE status = 'CANCELLED'")
  int purgeCancelled();
}
