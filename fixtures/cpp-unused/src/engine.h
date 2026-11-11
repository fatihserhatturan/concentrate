#pragma once
class Engine { public: void start(); };
class Spare { public: void idle(); };
int used_api(int v);
int unused_api(int v);
enum class Mode { Fast, Slow };
