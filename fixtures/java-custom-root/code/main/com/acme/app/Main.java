package com.acme.app;

import com.acme.model.User;                 // single-type import
import com.acme.model.*;                    // on-demand import (also brings Address)
import com.acme.util.Strings;
import static com.acme.util.Strings.upper;  // static single import
import static com.acme.util.Ids.*;          // static on-demand import
import java.util.List;                      // JDK, external
import jakarta.inject.Inject;               // external
import org.apache.commons.lang3.StringUtils; // unresolved third-party

public class Main {
    @Inject
    Helper helper;                          // same-package type, no import

    public static void main(String[] args) {
        User u = new User("ann", List.of("admin"));
        Address a = u.homeAddress();
        System.out.println(upper(u.getName()) + Strings.lower(a.street()) + next());
        System.out.println(StringUtils.capitalize("x"));
    }
}
