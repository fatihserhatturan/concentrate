CC = cc
CPPFLAGS = -Iinclude -DUSE_PARSER=1
CFLAGS = -Wall -O2
LIB_SRCS = src/util.c src/parser.c
LIB_OBJS = $(LIB_SRCS:src/%.c=build/%.o)

.PHONY: all clean

all: bin/app

bin/app: build/main.o libtools.a
	$(CC) $(LDFLAGS) -o $@ build/main.o -L. -ltools

libtools.a: $(LIB_OBJS)
	$(AR) rcs $@ $^

build/%.o: src/%.c
	mkdir -p build
	$(CC) $(CPPFLAGS) $(CFLAGS) -c $< -o $@

clean:
	rm -rf build bin libtools.a
