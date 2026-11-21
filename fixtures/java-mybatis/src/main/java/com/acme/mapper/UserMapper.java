package com.acme.mapper;

import java.util.List;
import org.apache.ibatis.annotations.Delete;
import org.apache.ibatis.annotations.Insert;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;
import org.apache.ibatis.annotations.SelectProvider;
import org.apache.ibatis.annotations.Update;

@Mapper
public interface UserMapper {
  String COLUMNS = "id, name, email";

  @Select("SELECT " + COLUMNS + " FROM users WHERE id = #{id}")
  User findById(@Param("id") long id);

  @Select({
      "SELECT u.id, r.name",
      "FROM users u",
      "JOIN user_roles r ON r.user_id = u.id",
      "WHERE u.id = #{id}"
  })
  List<String> rolesOf(@Param("id") long id);

  @Insert("INSERT INTO users (name, email) VALUES (#{name}, #{email})")
  int insert(User user);

  @Update("UPDATE users SET name = #{name} WHERE id = #{id}")
  int rename(@Param("id") long id, @Param("name") String name);

  @Delete("""
      DELETE FROM users
      WHERE id = #{id}
      """)
  int remove(@Param("id") long id);

  // Provider annotations are not read.
  @SelectProvider(type = UserSql.class, method = "search")
  List<User> search(String text);

  class User {
    public long id;
  }
}
