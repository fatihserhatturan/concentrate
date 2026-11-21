package com.acme.mapper;

import java.util.List;

// No annotations: the statements are in OrderMapper.xml.
public interface OrderMapper {
  List<String> search(String status, Long customerId);

  int insert(long customerId, String status);

  int cancelAll(List<Long> ids);

  List<String> notInXml();
}
