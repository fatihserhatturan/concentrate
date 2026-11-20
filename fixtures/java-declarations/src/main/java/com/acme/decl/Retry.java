package com.acme.decl;

import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;

@Retention(RetentionPolicy.RUNTIME)
public @interface Retry {
    int times() default 1;
    String reason() default "";
}
