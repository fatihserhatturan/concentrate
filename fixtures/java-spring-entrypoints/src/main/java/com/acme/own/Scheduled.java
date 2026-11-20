package com.acme.own;

public @interface Scheduled {
    String cron() default "";
}
