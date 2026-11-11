#define EXPORT_API __attribute__((visibility("default")))

int before() { return 1; }

EXPORT_API int exported(int x) { return x; }

DECLARE_HANDLER(on_event, int code) {
  return code +;
}

int after() { return before(); }
