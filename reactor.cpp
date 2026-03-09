#include <iostream>
#include <string>
#include <sstream>
#include <fstream>
#include <algorithm>
#include <cstdlib>
#include <ctime>
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <vector>
#include <windows.h>
#pragma comment(lib, "ws2_32.lib")

// ── SECTION: JSON_HELPERS ─────────────────────────────────────────────────────

std::string getJsonField(const std::string& json, const std::string& key) {
    std::string search = "\"" + key + "\"";
    size_t pos = json.find(search);
    if (pos == std::string::npos) return "";
    pos = json.find(":", pos);
    if (pos == std::string::npos) return "";
    pos++;
    while (pos < json.size() && (json[pos] == ' ' || json[pos] == '\t')) pos++;
    if (json[pos] == '"') {
        pos++;
        std::string val;
        while (pos < json.size() && json[pos] != '"') {
            if (json[pos] == '\\') pos++;
            val += json[pos++];
        }
        return val;
    }
    std::string val;
    while (pos < json.size() && json[pos] != ',' && json[pos] != '}') {
        val += json[pos++];
    }
    while (!val.empty() && (val.back() == ' ' || val.back() == '\t')) val.pop_back();
    return val;
}

// ── SECTION: PATH_HELPERS ─────────────────────────────────────────────────────

std::string getActionsDir() {
    char path[MAX_PATH];
    GetModuleFileNameA(NULL, path, MAX_PATH);
    std::string dir(path);
    size_t pos = dir.find_last_of("\\/");
    if (pos != std::string::npos) dir = dir.substr(0, pos);
    return dir + "\\actions";
}

std::string getMemoryPath() {
    char path[MAX_PATH];
    GetModuleFileNameA(NULL, path, MAX_PATH);
    std::string dir(path);
    size_t pos = dir.find_last_of("\\/");
    if (pos != std::string::npos) dir = dir.substr(0, pos);
    return dir + "\\memory.json";
}

std::string getConfigPath() {
    const char* envPath = getenv("CHATCOMMANDER_DATA_PATH");
    if (envPath) return std::string(envPath) + "\\config.json";
    char path[MAX_PATH];
    GetModuleFileNameA(NULL, path, MAX_PATH);
    std::string dir(path);
    size_t pos = dir.find_last_of("\\/");
    if (pos != std::string::npos) dir = dir.substr(0, pos);
    return dir + "\\config.json";
}

std::string getChannelFromConfig() {
    std::ifstream f(getConfigPath());
    if (!f.is_open()) return "";
    std::string json((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
    f.close();
    return getJsonField(json, "channel");
}
std::vector<std::string> getAdminsFromConfig() {
    std::cout << "[reactor] config path: " << getConfigPath() << std::endl;
    std::ifstream f(getConfigPath());
    if (!f.is_open()) return {};
    std::string json((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
    f.close();
    std::vector<std::string> admins;
    size_t pos = json.find("\"admins\"");
    if (pos == std::string::npos) return {};
    pos = json.find('[', pos);
    if (pos == std::string::npos) return {};
    size_t end = json.find(']', pos);
    if (end == std::string::npos) return {};
    std::string arr = json.substr(pos + 1, end - pos - 1);
    size_t i = 0;
    while ((i = arr.find('"', i)) != std::string::npos) {
        size_t j = arr.find('"', i + 1);
        if (j == std::string::npos) break;
        admins.push_back(arr.substr(i + 1, j - i - 1));
        i = j + 1;
    }
    return admins;
}
// ── SECTION: MEMORY ───────────────────────────────────────────────────────────

std::string memoryGet(const std::string& key) {
    std::string memPath = getMemoryPath();
    std::ifstream f(memPath);
    if (!f.is_open()) return "";
    std::string json((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
    f.close();
    return getJsonField(json, key);
}

void memorySet(const std::string& key, const std::string& value) {
    std::string memPath = getMemoryPath();

    std::string json = "{}";
    std::ifstream f(memPath);
    if (f.is_open()) {
        json = std::string((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
        f.close();
    }

    std::string search = "\"" + key + "\"";
    size_t pos = json.find(search);
    if (pos != std::string::npos) {
        size_t end = json.find(',', pos);
        if (end == std::string::npos) {
            size_t prev = json.rfind(',', pos);
            if (prev != std::string::npos && prev > 0) pos = prev;
            json = json.substr(0, pos) + "\n}";
        } else {
            json = json.substr(0, pos) + json.substr(end + 1);
        }
    }

    std::string escaped;
    for (char c : value) {
        if (c == '"') escaped += "\\\"";
        else if (c == '\\') escaped += "\\\\";
        else escaped += c;
    }

    size_t closing = json.rfind('}');
    if (closing == std::string::npos) {
        json = "{\"" + key + "\": \"" + escaped + "\"}";
    } else {
        bool empty = json.substr(0, closing).find(':') == std::string::npos;
        if (empty) {
            json = json.substr(0, closing) + "\"" + key + "\": \"" + escaped + "\"\n}";
        } else {
            json = json.substr(0, closing) + ",\n    \"" + key + "\": \"" + escaped + "\"\n}";
        }
    }

    std::ofstream out(memPath);
    out << json;
    out.close();
}

// ── SECTION: COMPILE ──────────────────────────────────────────────────────────

std::string compileAction(const std::string& actionName, const std::string& code) {
    std::string actionsDir = getActionsDir();
    CreateDirectoryA(actionsDir.c_str(), NULL);

    std::string srcPath = actionsDir + "\\" + actionName + ".cpp";
    std::string exePath = actionsDir + "\\" + actionName + ".exe";
    std::string memPath = getMemoryPath();

    std::ofstream src(srcPath);
    if (!src.is_open()) return "ERROR: Could not write source file";

    src << "#include <iostream>\n";
    src << "#include <string>\n";
    src << "#include <fstream>\n";
    src << "#include <sstream>\n";
    src << "#include <vector>\n";
    src << "#include <algorithm>\n";
    src << "#include <winsock2.h>\n";
    src << "#include <windows.h>\n";
    src << "#include <cstdlib>\n";
    src << "#include <ctime>\n\n";

    // Inject memory helpers
    src << "// ---- memory helpers ----\n";

    std::string escapedMemPath;
    for (char c : memPath) {
        if (c == '\\') escapedMemPath += "\\\\";
        else escapedMemPath += c;
    }
    src << "static std::string _memPath = \"" << escapedMemPath << "\";\n\n";

    src << "static std::string _getJsonField(const std::string& json, const std::string& key) {\n";
    src << "    std::string search = \"\\\"\" + key + \"\\\"\";\n";
    src << "    size_t pos = json.find(search);\n";
    src << "    if (pos == std::string::npos) return \"\";\n";
    src << "    pos = json.find(\":\", pos);\n";
    src << "    if (pos == std::string::npos) return \"\";\n";
    src << "    pos++;\n";
    src << "    while (pos < json.size() && (json[pos] == ' ' || json[pos] == '\\t')) pos++;\n";
    src << "    if (json[pos] == '\"') {\n";
    src << "        pos++;\n";
    src << "        std::string val;\n";
    src << "        while (pos < json.size() && json[pos] != '\"') {\n";
    src << "            if (json[pos] == '\\\\') pos++;\n";
    src << "            val += json[pos++];\n";
    src << "        }\n";
    src << "        return val;\n";
    src << "    }\n";
    src << "    std::string val;\n";
    src << "    while (pos < json.size() && json[pos] != ',' && json[pos] != '}') val += json[pos++];\n";
    src << "    while (!val.empty() && (val.back() == ' ' || val.back() == '\\t')) val.pop_back();\n";
    src << "    return val;\n";
    src << "}\n\n";

    src << "static std::string memGet(const std::string& key) {\n";
    src << "    std::ifstream f(_memPath);\n";
    src << "    if (!f.is_open()) return \"\";\n";
    src << "    std::string json((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());\n";
    src << "    f.close();\n";
    src << "    return _getJsonField(json, key);\n";
    src << "}\n\n";

    src << "static void memSet(const std::string& key, const std::string& value) {\n";
    src << "    std::string json = \"{}\";\n";
    src << "    std::ifstream f(_memPath);\n";
    src << "    if (f.is_open()) {\n";
    src << "        json = std::string((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());\n";
    src << "        f.close();\n";
    src << "    }\n";
    src << "    std::string search = \"\\\"\" + key + \"\\\"\";\n";
    src << "    size_t pos = json.find(search);\n";
    src << "    if (pos != std::string::npos) {\n";
    src << "        size_t end = json.find(',', pos);\n";
    src << "        if (end == std::string::npos) {\n";
    src << "            size_t prev = json.rfind(',', pos);\n";
    src << "            if (prev != std::string::npos) pos = prev;\n";
    src << "            json = json.substr(0, pos) + \"\\n}\";\n";
    src << "        } else {\n";
    src << "            json = json.substr(0, pos) + json.substr(end + 1);\n";
    src << "        }\n";
    src << "    }\n";
    src << "    std::string escaped;\n";
    src << "    for (char c : value) {\n";
    src << "        if (c == '\"') escaped += \"\\\\\\\"\";\n";
    src << "        else if (c == '\\\\') escaped += \"\\\\\\\\\";\n";
    src << "        else escaped += c;\n";
    src << "    }\n";
    src << "    size_t closing = json.rfind('}');\n";
    src << "    if (closing == std::string::npos) {\n";
    src << "        json = \"{\\\"\" + key + \"\\\": \\\"\" + escaped + \"\\\"}\";\n";
    src << "    } else {\n";
    src << "        bool empty = json.substr(0, closing).find(':') == std::string::npos;\n";
    src << "        if (empty) json = json.substr(0, closing) + \"\\\"\" + key + \"\\\": \\\"\" + escaped + \"\\\"\\n}\";\n";
    src << "        else json = json.substr(0, closing) + \",\\n    \\\"\" + key + \"\\\": \\\"\" + escaped + \"\\\"\\n}\";\n";
    src << "    }\n";
    src << "    std::ofstream out(_memPath);\n";
    src << "    out << json;\n";
    src << "    out.close();\n";
    src << "}\n";
    src << "// ---- end memory helpers ----\n\n";

    src << "int main(int argc, char* argv[]) {\n";
    src << "    std::string username = argc > 1 ? argv[1] : \"\";\n";
    src << "    std::string message  = argc > 2 ? argv[2] : \"\";\n";
    src << "    std::string args     = argc > 3 ? argv[3] : \"\";\n";
    src << "    std::string channel  = argc > 4 ? argv[4] : \"\";\n\n";
    src << "    // --- YOUR CODE ---\n";
    src << code << "\n";
    src << "    // --- END ---\n";
    src << "    return 0;\n";
    src << "}\n";
    src.close();

    std::string cmd = "g++ \"" + srcPath + "\" -o \"" + exePath + "\" -lws2_32 2>&1";
    FILE* pipe = _popen(cmd.c_str(), "r");
    if (!pipe) return "ERROR: Could not run g++";

    std::string result;
    char buf[256];
    while (fgets(buf, sizeof(buf), pipe)) result += buf;
    int exitCode = _pclose(pipe);

    if (exitCode == 0) return "OK";
    else return "COMPILE_ERROR:" + result;
}

// ── SECTION: RUN ──────────────────────────────────────────────────────────────

void runAction(const std::string& actionName, const std::string& username,
               const std::string& message, const std::string& args,
               const std::string& channel) {
    std::string exePath = getActionsDir() + "\\" + actionName + ".exe";

    if (GetFileAttributesA(exePath.c_str()) == INVALID_FILE_ATTRIBUTES) {
        std::cout << "[reactor] Action exe not found: " << exePath << std::endl;
        return;
    }

    std::string cmd = "\"" + exePath + "\" \"" + username + "\" \"" + message + "\" \"" + args + "\" \"" + channel + "\"";

    STARTUPINFOA si = {};
    PROCESS_INFORMATION pi = {};
    si.cb = sizeof(si);

    if (CreateProcessA(NULL, (LPSTR)cmd.c_str(), NULL, NULL, FALSE,
                       CREATE_NO_WINDOW, NULL, NULL, &si, &pi)) {
        WaitForSingleObject(pi.hProcess, 5000);
        CloseHandle(pi.hProcess);
        CloseHandle(pi.hThread);
        std::cout << "[reactor] Action ran: " << actionName << std::endl;
    } else {
        std::cout << "[reactor] Failed to run action: " << actionName << std::endl;
    }
}

// ── SECTION: SEND_TO_BOT ─────────────────────────────────────────────────────
// Forward declared here so bank.cpp and gamble.cpp can call it freely

void sendToBot(const std::string& msg) {
    SOCKET s = socket(AF_INET, SOCK_STREAM, 0);
    sockaddr_in addr;
    addr.sin_family = AF_INET;
    addr.sin_port = htons(9001);
    inet_pton(AF_INET, "127.0.0.1", &addr.sin_addr);
    if (connect(s, (sockaddr*)&addr, sizeof(addr)) == 0) {
        send(s, msg.c_str(), (int)msg.size(), 0);
    }
    closesocket(s);
}

// ── SECTION: BANK_INCLUDE ─────────────────────────────────────────────────────
#include "bank.cpp"

// ── SECTION: GAMBLE_INCLUDE ───────────────────────────────────────────────────
#include "gamble.cpp"

// ── SECTION: CAR_INCLUDE ─────────────────────────────────────────────────────
#include "car.cpp"

// ── SECTION: MESSAGE_HANDLER ──────────────────────────────────────────────────

void handleMessage(const std::string& raw, SOCKET client) {
    if (raw.size() >= 8 && raw.substr(0, 8) == "COMPILE:") {
        size_t p1 = raw.find(':', 8);
        if (p1 == std::string::npos) {
            std::string err = "COMPILE_RESULT:COMPILE_ERROR:Bad format";
            send(client, err.c_str(), (int)err.size(), 0);
            return;
        }
        std::string name = raw.substr(8, p1 - 8);
        std::string code = raw.substr(p1 + 1);
        std::cout << "[reactor] Compiling action: " << name << std::endl;
        std::string result = compileAction(name, code);
        std::string response = "COMPILE_RESULT:" + result;
        send(client, response.c_str(), (int)response.size(), 0);
        std::cout << "[reactor] Compile result: " << result << std::endl;
    }
    else if (raw.size() >= 4 && raw.substr(0, 4) == "RUN:") {
        std::string rest = raw.substr(4);
        std::stringstream ss(rest);
        std::string name, username, message, args, channel;
        std::getline(ss, name, ':');
        std::getline(ss, username, ':');
        std::getline(ss, message, ':');
        std::getline(ss, args, ':');
        std::getline(ss, channel);
        runAction(name, username, message, args, channel);
    }
    else if (raw.size() >= 8 && raw.substr(0, 8) == "COMMAND:") {
        std::string rest = raw.substr(8);
        std::stringstream ss(rest);
        std::string command, username, message, args, channel;
        std::getline(ss, command, ':');
        std::getline(ss, username, ':');
        std::getline(ss, message, ':');
        std::getline(ss, args, ':');
        std::getline(ss, channel);
        if (channel.empty()) channel = getChannelFromConfig();
        std::cout << "[reactor] Chat command: " << command << " from " << username << std::endl;
        // ── hardcoded default commands ────────────────────────────────────────
      std::vector<std::string> admins = getAdminsFromConfig();
        std::cout << "[reactor] admins loaded: " << admins.size() << std::endl;
for (auto& a : admins) std::cout << "[reactor] admin: " << a << std::endl;
      
      if (command == "bank") {
            handleBank(username, args, channel, admins);
        } else if (command == "gamble") {
            handleGamble(username, args, channel);
        } else if (command == "car") {
            handleCar(username, args, channel);
        } else {
            runAction(command, username, message, args, channel);
        }
    }
    else if (raw.size() >= 11 && raw.substr(0, 11) == "MEMORY_GET:") {
        std::string key = raw.substr(11);
        std::string value = memoryGet(key);
        send(client, value.c_str(), (int)value.size(), 0);
        std::cout << "[reactor] MEMORY_GET: " << key << " = " << value << std::endl;
    }
    else if (raw.size() >= 11 && raw.substr(0, 11) == "MEMORY_SET:") {
        std::string rest = raw.substr(11);
        size_t sep = rest.find(':');
        if (sep != std::string::npos) {
            std::string key   = rest.substr(0, sep);
            std::string value = rest.substr(sep + 1);
            memorySet(key, value);
            std::string ok = "OK";
            send(client, ok.c_str(), (int)ok.size(), 0);
            std::cout << "[reactor] MEMORY_SET: " << key << " = " << value << std::endl;
        }
    }
    else {
        std::cout << "[reactor] Legacy command: " << raw << std::endl;
    }
}

// ── SECTION: MAIN ─────────────────────────────────────────────────────────────

int main() {
    WSADATA wsaData;
    WSAStartup(MAKEWORD(2, 2), &wsaData);

    SOCKET server = socket(AF_INET, SOCK_STREAM, 0);
    int opt = 1;
    setsockopt(server, SOL_SOCKET, SO_REUSEADDR, (char*)&opt, sizeof(opt));

    sockaddr_in addr;
    addr.sin_family = AF_INET;
    addr.sin_port = htons(9000);
    addr.sin_addr.s_addr = INADDR_ANY;

    bind(server, (sockaddr*)&addr, sizeof(addr));
    listen(server, 5);

    std::cout << "C++ Reactor is running on port 9000..." << std::endl;
    std::cout << "Actions directory: " << getActionsDir() << std::endl;

    while (true) {
        SOCKET client = accept(server, nullptr, nullptr);
        if (client == INVALID_SOCKET) continue;

        std::string fullMsg;
        char buf[4096];
        int bytes;
        while ((bytes = recv(client, buf, sizeof(buf) - 1, 0)) > 0) {
            buf[bytes] = '\0';
            fullMsg += buf;
            if (bytes < (int)sizeof(buf) - 1) break;
        }

        if (!fullMsg.empty()) {
            handleMessage(fullMsg, client);
        }

        closesocket(client);
    }

    WSACleanup();
    return 0;
}