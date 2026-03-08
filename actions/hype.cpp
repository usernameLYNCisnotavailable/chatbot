#include <iostream>
#include <string>
#include <windows.h>

int main(int argc, char* argv[]) {
    std::string username = argc > 1 ? argv[1] : "";
    std::string message  = argc > 2 ? argv[2] : "";
    std::string args     = argc > 3 ? argv[3] : "";

    // --- YOUR CODE ---
Beep(800, 200);
Beep(1000, 200);
Beep(1200, 400);
    // --- END ---
    return 0;
}
