#include <iostream>
#include <string>
#include <windows.h>

int main(int argc, char* argv[]) {
    std::string username = argc > 1 ? argv[1] : "";
    std::string message  = argc > 2 ? argv[2] : "";
    std::string args     = argc > 3 ? argv[3] : "";

    // --- YOUR CODE ---
SYSTEMTIME st;
GetLocalTime(&st);
char timeStr[64];
sprintf(timeStr, "%02d:%02d:%02d", st.wHour, st.wMinute, st.wSecond);
MessageBoxA(NULL, timeStr, "Current Time", MB_OK);
    // --- END ---
    return 0;
}
