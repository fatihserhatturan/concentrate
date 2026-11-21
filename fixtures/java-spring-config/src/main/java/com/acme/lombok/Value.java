package com.acme.lombok;

public @interface Value {
  String value() default "";
}
