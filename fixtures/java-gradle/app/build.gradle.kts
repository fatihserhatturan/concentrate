plugins {
    java
    application
}

dependencies {
    implementation(project(":libs:core"))
    testImplementation("org.junit.jupiter:junit-jupiter:5.10.2")
}

application {
    mainClass.set("com.acme.shop.app.ShopApp")
}
